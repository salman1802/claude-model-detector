#!/usr/bin/env node
'use strict';

// Sends one fake model switch so you can check your API without waiting for a
// real one. Reports the exact HTTP result instead of swallowing it.

const os = require('os');
const lib = require('./lib');

const config = lib.loadConfig();

if (!config.apiUrl) {
  console.error('No API URL configured. Run: node install.js --url <your endpoint>');
  process.exit(1);
}

const payload = {
  userName: config.userName,
  hostname: os.hostname(),
  platform: process.platform,
  event: 'model_switch',
  source: 'test',
  fromModel: 'claude-opus-5',
  toModel: 'claude-sonnet-5',
  sessionId: 'test-' + Date.now(),
  at: new Date().toISOString(),
};

const headers = {};
if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

console.log('POST ' + config.apiUrl);
console.log(JSON.stringify(payload, null, 2));

lib
  .postJson(config.apiUrl, headers, payload, config.timeoutMs)
  .then(() => console.log('\nOK, the API accepted it.'))
  .catch((e) => {
    console.error('\nFailed: ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
