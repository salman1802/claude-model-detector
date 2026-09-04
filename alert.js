#!/usr/bin/env node
'use strict';

// Claude Code hook: reports every model switch to your API.
//
// Registered by install.js on three events:
//   PostModelSwitch  the model actually changed. Sends the alert.
//   SessionStart     records the starting model. Sends nothing.
//   Stop             fallback. Compares the last assistant model in the
//                    transcript against what we recorded, and sends an alert
//                    if it changed on its own (for example an automatic
//                    downgrade when a limit is hit).
//
// This script must never break the session, so every path exits 0.

const os = require('os');
const lib = require('./lib');

const PLATFORM = process.platform;
const HOSTNAME = (function () {
  try {
    return os.hostname();
  } catch (e) {
    return 'unknown';
  }
})();

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Release the handle, otherwise it keeps the process alive after we are
      // finished and the hook looks like it hung.
      process.stdin.pause();
      resolve(data);
    };
    // If nothing arrives, do not hang the session.
    const timer = setTimeout(finish, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function buildEvent(fields) {
  return {
    userName: CONFIG.userName,
    hostname: HOSTNAME,
    platform: PLATFORM,
    event: 'model_switch',
    source: fields.source,
    fromModel: fields.fromModel || null,
    toModel: fields.toModel || null,
    sessionId: fields.sessionId || null,
    at: new Date().toISOString(),
  };
}

// Sends the backlog first, then the new event. A failure lands in the spool
// and goes out on the next hook fire.
async function send(event) {
  const headers = {};
  if (CONFIG.apiKey) headers.Authorization = 'Bearer ' + CONFIG.apiKey;

  const pending = lib.readSpool();
  const stillFailing = [];
  let backlogBroken = false;

  for (const item of pending) {
    if (backlogBroken) {
      stillFailing.push(item);
      continue;
    }
    try {
      await lib.postJson(CONFIG.apiUrl, headers, item, CONFIG.timeoutMs);
    } catch (e) {
      // The API is still unreachable. Keep the rest queued in order.
      backlogBroken = true;
      stillFailing.push(item);
    }
  }

  if (event) {
    if (backlogBroken) {
      stillFailing.push(event);
    } else {
      try {
        await lib.postJson(CONFIG.apiUrl, headers, event, CONFIG.timeoutMs);
      } catch (e) {
        lib.logError('send', e);
        stillFailing.push(event);
      }
    }
  }

  lib.writeSpool(stillFailing);
}

async function main() {
  const raw = await readStdin();

  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (e) {
    lib.logError('parse-stdin', e);
  }

  if (!CONFIG.enabled || !CONFIG.apiUrl) return;

  const eventName = input.hook_event_name || '';
  const sessionId = input.session_id || null;
  const state = lib.loadState();
  let outgoing = null;

  if (eventName === 'PostModelSwitch' || eventName === 'PreModelSwitch') {
    const toModel = input.to_model || input.toModel || null;
    const fromModel =
      input.from_model || input.fromModel || lib.getSessionModel(state, sessionId);
    if (toModel && toModel !== fromModel) {
      outgoing = buildEvent({
        source: 'hook',
        fromModel: fromModel,
        toModel: toModel,
        sessionId: sessionId,
      });
    }
    // Record it either way, so the Stop fallback does not report it again.
    lib.setSessionModel(state, sessionId, toModel);
  } else if (eventName === 'SessionStart') {
    // Seed the baseline only. A new session is not a switch.
    const model = input.model || lib.lastAssistantModel(input.transcript_path);
    lib.setSessionModel(state, sessionId, model);
  } else {
    // Stop, or anything else we get wired to: the transcript fallback.
    const current = lib.lastAssistantModel(input.transcript_path);
    if (current) {
      const previous = lib.getSessionModel(state, sessionId);
      if (previous && previous !== current) {
        outgoing = buildEvent({
          source: 'transcript',
          fromModel: previous,
          toModel: current,
          sessionId: sessionId,
        });
      }
      lib.setSessionModel(state, sessionId, current);
    }
  }

  lib.saveState(state);

  if (outgoing) await send(outgoing);
}

const CONFIG = lib.loadConfig();

// Exit code 0 always, so a hook failure never disturbs the session. The
// process is left to end on its own rather than forced with process.exit(),
// which can abort mid-write on a socket that is still closing.
main()
  .catch((e) => lib.logError('main', e))
  .then(() => {
    process.exitCode = 0;
  });
