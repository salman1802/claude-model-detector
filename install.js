#!/usr/bin/env node
'use strict';

// One time setup. Registers alert.js as a Claude Code hook and writes the
// config. Works the same on Windows, macOS and Linux.
//
//   node install.js --url https://example.com/model-switch --user salman
//
// Options:
//   --url <url>      where to POST the alerts (required)
//   --key <token>    sent as "Authorization: Bearer <token>" (optional)
//   --user <name>    who this machine reports as (default: OS username)
//   --timeout <ms>   HTTP timeout, default 5000
//   --scope <s>      "user" (all projects, default) or "project" (this repo)
//   --dry            print what would change, write nothing

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const lib = require('./lib');

const ALERT_PATH = path.join(__dirname, 'alert.js').replace(/\\/g, '/');
const MARKER = 'model-switch-alert';
const HOOK_COMMAND = 'node "' + ALERT_PATH + '"';
const EVENTS = ['PostModelSwitch', 'SessionStart', 'Stop'];

function parseArgs(argv) {
  const args = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--dry') {
      args.dry = true;
    } else if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function settingsPath(scope) {
  if (scope === 'project') return path.join(process.cwd(), '.claude', 'settings.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function isOurs(handler) {
  return (
    handler &&
    typeof handler.command === 'string' &&
    handler.command.indexOf(MARKER) !== -1
  );
}

// Drops any previous entries of ours, then adds the current one. Running the
// installer twice leaves exactly one hook per event.
function mergeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = [];

    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        cleaned.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isOurs(h));
      if (handlers.length) cleaned.push(Object.assign({}, group, { hooks: handlers }));
    }

    cleaned.push({
      hooks: [
        {
          type: 'command',
          command: HOOK_COMMAND,
          async: true,
          timeout: 20,
        },
      ],
    });

    settings.hooks[event] = cleaned;
  }

  return settings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const existing = lib.readJson(lib.CONFIG_FILE, {});

  let apiUrl = args.url || existing.apiUrl || '';
  if (!apiUrl) {
    if (!process.stdin.isTTY) {
      console.error('Missing --url. Example:');
      console.error('  node install.js --url https://example.com/model-switch --user salman');
      process.exit(1);
    }
    apiUrl = await ask('API URL to POST alerts to: ');
  }
  if (!/^https?:\/\//i.test(apiUrl)) {
    console.error('The URL must start with http:// or https://');
    process.exit(1);
  }

  const config = {
    apiUrl: apiUrl,
    apiKey: args.key !== undefined ? args.key : existing.apiKey || '',
    userName: args.user || existing.userName || lib.defaultUserName(),
    timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) : existing.timeoutMs || 5000,
    enabled: true,
  };

  const target = settingsPath(args.scope === 'project' ? 'project' : 'user');
  const settings = lib.readJson(target, {});
  const updated = mergeHooks(settings);

  if (args.dry) {
    console.log('Would write config to ' + lib.CONFIG_FILE);
    console.log(JSON.stringify(Object.assign({}, config, { apiKey: config.apiKey ? '***' : '' }), null, 2));
    console.log('\nWould write hooks to ' + target);
    console.log(JSON.stringify({ hooks: updated.hooks }, null, 2));
    return;
  }

  lib.writeJson(lib.CONFIG_FILE, config);

  // Back up before touching an existing settings file.
  if (fs.existsSync(target)) {
    fs.copyFileSync(target, target + '.bak-' + Date.now());
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  console.log('Installed.');
  console.log('  hooks   ' + target);
  console.log('  config  ' + lib.CONFIG_FILE);
  console.log('  reports as  ' + config.userName + ' @ ' + os.hostname());
  console.log('  posts to    ' + config.apiUrl);
  console.log('');
  console.log('Restart any open Claude Code session to pick up the new hooks.');
  console.log('Test it without waiting for a real switch:  node test-send.js');
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
