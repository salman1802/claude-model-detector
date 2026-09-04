#!/usr/bin/env node
'use strict';

// Removes the hook entries this tool added. Leaves your other hooks alone.
//
//   node uninstall.js              remove from ~/.claude/settings.json
//   node uninstall.js --scope project
//   node uninstall.js --purge      also delete the config, state and spool

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const MARKER = 'model-switch-alert';

function parseArgs(argv) {
  const args = { purge: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--purge') args.purge = true;
    else if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const target =
  args.scope === 'project'
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(os.homedir(), '.claude', 'settings.json');

if (!fs.existsSync(target)) {
  console.log('Nothing to do, no settings file at ' + target);
  process.exit(0);
}

const settings = lib.readJson(target, {});
let removed = 0;

if (settings.hooks && typeof settings.hooks === 'object') {
  for (const event of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = [];

    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        cleaned.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => {
        const ours = h && typeof h.command === 'string' && h.command.indexOf(MARKER) !== -1;
        if (ours) removed++;
        return !ours;
      });
      if (handlers.length) cleaned.push(Object.assign({}, group, { hooks: handlers }));
    }

    if (cleaned.length) settings.hooks[event] = cleaned;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

fs.copyFileSync(target, target + '.bak-' + Date.now());
fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('Removed ' + removed + ' hook entr' + (removed === 1 ? 'y' : 'ies') + ' from ' + target);

if (args.purge) {
  for (const file of [lib.CONFIG_FILE, lib.STATE_FILE, lib.SPOOL_FILE, lib.ERROR_LOG]) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log('Deleted ' + file);
      }
    } catch (e) {
      console.error('Could not delete ' + file + ': ' + e.message);
    }
  }
}
