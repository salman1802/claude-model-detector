'use strict';

// Shared helpers for the Claude Code model switch alert.
// No dependencies. Node 16+.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.claude', 'model-switch-alert');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SPOOL_FILE = path.join(DATA_DIR, 'spool.jsonl');
const ERROR_LOG = path.join(DATA_DIR, 'error.log');

const SPOOL_MAX = 200;
const STATE_MAX = 200;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function defaultUserName() {
  try {
    return os.userInfo().username;
  } catch (e) {
    return process.env.USERNAME || process.env.USER || 'unknown';
  }
}

// Env wins over the config file, so a machine can override without editing it.
function loadConfig() {
  const file = readJson(CONFIG_FILE, {});
  return {
    apiUrl: process.env.MODEL_SWITCH_API_URL || file.apiUrl || '',
    apiKey: process.env.MODEL_SWITCH_API_KEY || file.apiKey || '',
    userName: process.env.MODEL_SWITCH_USER || file.userName || defaultUserName(),
    timeoutMs: Number(file.timeoutMs) > 0 ? Number(file.timeoutMs) : 5000,
    enabled: file.enabled === false ? false : true,
  };
}

function logError(where, err) {
  try {
    ensureDataDir();
    const detail = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(ERROR_LOG, new Date().toISOString() + ' [' + where + '] ' + detail + '\n', 'utf8');
    // Keep the log from growing without bound.
    if (fs.statSync(ERROR_LOG).size > 256 * 1024) {
      const text = fs.readFileSync(ERROR_LOG, 'utf8');
      fs.writeFileSync(ERROR_LOG, text.slice(-64 * 1024), 'utf8');
    }
  } catch (e) {
    // Never let logging break the hook.
  }
}

/* ------------------------------------------------------------------ */
/* State: last known model per session                                 */
/* ------------------------------------------------------------------ */

function loadState() {
  const state = readJson(STATE_FILE, {});
  return state && typeof state === 'object' ? state : {};
}

function saveState(state) {
  const now = Date.now();
  const keys = Object.keys(state)
    .filter((k) => state[k] && now - (state[k].t || 0) < STATE_TTL_MS)
    .sort((a, b) => (state[b].t || 0) - (state[a].t || 0))
    .slice(0, STATE_MAX);
  const pruned = {};
  for (const k of keys) pruned[k] = state[k];
  writeJson(STATE_FILE, pruned);
}

function getSessionModel(state, sessionId) {
  const entry = sessionId ? state[sessionId] : null;
  return entry ? entry.model : null;
}

function setSessionModel(state, sessionId, model) {
  if (!sessionId || !model) return;
  state[sessionId] = { model: model, t: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Transcript reading                                                  */
/* ------------------------------------------------------------------ */

// Reads the tail of a session JSONL and returns the model of the most recent
// main-thread assistant message. Sidechain (subagent) lines are skipped,
// otherwise a subagent running a different model looks like a switch.
function lastAssistantModel(transcriptPath) {
  if (!transcriptPath) return null;
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return null;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // The first line is probably truncated when we did not read the whole file.
    if (size > len) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      if (line.indexOf('"assistant"') === -1) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (obj.type !== 'assistant' || obj.isSidechain) continue;
      const model = obj.message && obj.message.model;
      if (model && model !== '<synthetic>') return model;
    }
    return null;
  } catch (e) {
    logError('lastAssistantModel', e);
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* Spool: retry posts that failed while offline                        */
/* ------------------------------------------------------------------ */

function readSpool() {
  try {
    if (!fs.existsSync(SPOOL_FILE)) return [];
    return fs
      .readFileSync(SPOOL_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    logError('readSpool', e);
    return [];
  }
}

function writeSpool(items) {
  try {
    ensureDataDir();
    const kept = items.slice(-SPOOL_MAX);
    if (!kept.length) {
      if (fs.existsSync(SPOOL_FILE)) fs.unlinkSync(SPOOL_FILE);
      return;
    }
    fs.writeFileSync(SPOOL_FILE, kept.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
  } catch (e) {
    logError('writeSpool', e);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

// Deliberately uses http/https rather than fetch. Keep-alive is off, so the
// socket closes as soon as the response lands and the process can exit
// straight away. fetch keeps pooled sockets open, which crashed the hook on
// exit under Windows.
function postJson(url, headers, body, timeoutMs) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let mod, opts;
    try {
      const parsed = new URL(url);
      mod = parsed.protocol === 'http:' ? require('http') : require('https');
      opts = {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          headers
        ),
        timeout: timeoutMs,
        agent: false,
      };
    } catch (e) {
      return reject(e);
    }
    const req = mod.request(opts, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
      else reject(new Error('HTTP ' + res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  DATA_DIR: DATA_DIR,
  CONFIG_FILE: CONFIG_FILE,
  STATE_FILE: STATE_FILE,
  SPOOL_FILE: SPOOL_FILE,
  ERROR_LOG: ERROR_LOG,
  ensureDataDir: ensureDataDir,
  readJson: readJson,
  writeJson: writeJson,
  loadConfig: loadConfig,
  defaultUserName: defaultUserName,
  logError: logError,
  loadState: loadState,
  saveState: saveState,
  getSessionModel: getSessionModel,
  setSessionModel: setSessionModel,
  lastAssistantModel: lastAssistantModel,
  readSpool: readSpool,
  writeSpool: writeSpool,
  postJson: postJson,
};
