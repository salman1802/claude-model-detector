#!/usr/bin/env node
'use strict';

// Regression tests. Run with: node test.js
//
// Drives alert.js the way Claude Code does, with hook JSON on stdin, and
// counts what reaches a receiver. Your real state.json and config.json are
// backed up and restored, so this is safe to run on a live machine.
//
// The receiver runs in its own process on purpose. alert.js is launched with
// spawnSync, which blocks this process, so a receiver living here could never
// answer the request.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ALERT = path.join(__dirname, 'alert.js');
const DATA_DIR = path.join(os.homedir(), '.claude', 'model-switch-alert');
const STATE = path.join(DATA_DIR, 'state.json');
const CONFIG = path.join(DATA_DIR, 'config.json');
const SPOOL = path.join(DATA_DIR, 'spool.jsonl');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msa-test-'));
const LOG = path.join(TMP, 'received.log');
const PORT = 4633;

const RECEIVER = [
  "const fs=require('fs'),http=require('http');const log=process.argv[1];",
  "http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);",
  "q.on('end',()=>{fs.appendFileSync(log,b+'\\n');s.writeHead(200).end('{}')})})",
  '.listen(' + PORT + ",()=>fs.writeFileSync(log,''));",
].join('');

let failures = 0;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rm(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {}
}

// One main-thread assistant message per model, in order, so the last one is
// what the transcript fallback reads. An optional subagent line goes last.
function transcript(name, models, sidechainModel) {
  const lines = models.map((m) =>
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: m } })
  );
  if (sidechainModel) {
    lines.push(
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: sidechainModel } })
    );
  }
  const file = path.join(TMP, name + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function fire(input) {
  spawnSync(process.execPath, [ALERT], {
    input: JSON.stringify(input),
    env: Object.assign({}, process.env, {
      MODEL_SWITCH_API_URL: 'http://127.0.0.1:' + PORT + '/e',
      MODEL_SWITCH_USER: 'tester',
    }),
    encoding: 'utf8',
  });
}

function sent() {
  const text = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function test(name, steps, expected) {
  rm(STATE);
  rm(SPOOL);
  fs.writeFileSync(LOG, '');
  steps();
  const got = sent();
  const ok = got.length === expected;
  if (!ok) failures++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + name + '  (alerts: ' + got.length + ', expected ' + expected + ')'
  );
  got.forEach((r) =>
    console.log('          ' + r.fromModel + ' -> ' + r.toModel + '  [' + r.source + ']')
  );
  // Anything left queued means a post never landed, which would skew the next test.
  if (fs.existsSync(SPOOL)) {
    console.log('          WARNING: ' + sent().length + ' alert(s) were spooled, the receiver did not answer');
    failures++;
  }
}

const savedState = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;
const savedConfig = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG) : null;
const savedSpool = fs.existsSync(SPOOL) ? fs.readFileSync(SPOOL) : null;

const receiver = spawn(process.execPath, ['-e', RECEIVER, LOG], { stdio: 'ignore' });

// The receiver creates the log file once it is listening.
for (let i = 0; i < 100 && !fs.existsSync(LOG); i++) sleep(50);
if (!fs.existsSync(LOG)) {
  console.error('receiver failed to start on port ' + PORT);
  receiver.kill();
  process.exit(1);
}

try {
  const opus = transcript('opus', ['claude-opus-5']);
  const sonnet = transcript('sonnet', ['claude-opus-5', 'claude-sonnet-5']);
  const withSub = transcript('sub', ['claude-opus-5'], 'claude-haiku-4-5-20251001');

  console.log('\nmodel-switch-alert regression tests\n');

  // The bug that shipped: the hook says claude-opus-5[1m], the transcript says
  // claude-opus-5. Same model, so this must stay quiet.
  test(
    'no false alert when hook and transcript spell the model differently',
    () => {
      fire({ hook_event_name: 'SessionStart', session_id: 'a', model: 'claude-opus-5[1m]' });
      fire({ hook_event_name: 'Stop', session_id: 'a', transcript_path: opus });
    },
    0
  );

  test(
    'a real switch is reported',
    () => {
      fire({
        hook_event_name: 'PostModelSwitch',
        session_id: 'b',
        from_model: 'claude-opus-5',
        to_model: 'claude-sonnet-5',
      });
    },
    1
  );

  test(
    'Stop does not repeat the switch the hook already sent',
    () => {
      fire({
        hook_event_name: 'PostModelSwitch',
        session_id: 'c',
        from_model: 'claude-opus-5',
        to_model: 'claude-sonnet-5',
      });
      fire({ hook_event_name: 'Stop', session_id: 'c', transcript_path: sonnet });
    },
    1
  );

  // The fallback still has to catch a downgrade nobody asked for.
  test(
    'an automatic downgrade is caught from the transcript',
    () => {
      fire({ hook_event_name: 'Stop', session_id: 'd', transcript_path: opus });
      fire({ hook_event_name: 'Stop', session_id: 'd', transcript_path: sonnet });
    },
    1
  );

  test(
    'repeated Stop with no change stays quiet',
    () => {
      fire({ hook_event_name: 'Stop', session_id: 'e', transcript_path: opus });
      fire({ hook_event_name: 'Stop', session_id: 'e', transcript_path: opus });
      fire({ hook_event_name: 'Stop', session_id: 'e', transcript_path: opus });
    },
    0
  );

  test(
    'a subagent on another model is not a switch',
    () => {
      fire({ hook_event_name: 'Stop', session_id: 'f', transcript_path: opus });
      fire({ hook_event_name: 'Stop', session_id: 'f', transcript_path: withSub });
    },
    0
  );

  test(
    'state written by an older version is not compared',
    () => {
      fs.writeFileSync(STATE, JSON.stringify({ g: { model: 'claude-opus-5[1m]', t: Date.now() } }));
      fire({ hook_event_name: 'Stop', session_id: 'g', transcript_path: sonnet });
    },
    0
  );

  test(
    'a session start alone never alerts',
    () => {
      fire({ hook_event_name: 'SessionStart', session_id: 'h', model: 'claude-opus-5' });
    },
    0
  );

  test(
    'malformed and empty input do not alert or crash',
    () => {
      fire({});
      spawnSync(process.execPath, [ALERT], { input: 'not json', encoding: 'utf8' });
    },
    0
  );
} finally {
  receiver.kill();
  rm(STATE);
  rm(SPOOL);
  if (savedState) fs.writeFileSync(STATE, savedState);
  if (savedConfig) fs.writeFileSync(CONFIG, savedConfig);
  if (savedSpool) fs.writeFileSync(SPOOL, savedSpool);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + (failures ? failures + ' FAILED' : 'all passed') + '\n');
process.exitCode = failures ? 1 : 0;
