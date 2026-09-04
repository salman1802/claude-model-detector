# claude-model-switch-alert

Sends an alert to your own API every time Claude Code changes model.

Install once per machine. After that it runs on its own. There is no background
process, no startup entry and nothing to launch. Claude Code itself runs the
script at the moment a switch happens, and the script exits straight away.

Works on Windows, macOS and Linux. Node 16 or newer. No dependencies.

## Install

On every PC:

```bash
git clone <this repo> claude-model-switch-alert
cd claude-model-switch-alert
node install.js --url https://your-api.example.com/model-switch --user salman
```

That writes the hooks into `~/.claude/settings.json` and saves the config to
`~/.claude/model-switch-alert/config.json`. Restart any Claude Code session that
is already open.

Check it works without waiting for a real switch:

```bash
node test-send.js
```

### Options

| Flag | Meaning |
| --- | --- |
| `--url <url>` | Where to POST the alerts. Required the first time. |
| `--key <token>` | Sent as `Authorization: Bearer <token>`. Optional. |
| `--user <name>` | Who this machine reports as. Defaults to the OS username. |
| `--timeout <ms>` | HTTP timeout. Default 5000. |
| `--scope project` | Install for the current repo only instead of every project. |
| `--dry` | Print what would change and write nothing. |

Running the installer again is safe. It replaces its own entries and leaves
every other hook alone. A timestamped backup of `settings.json` is written
first.

Environment variables override the config file, which is handy for a shared
machine or CI:

```
MODEL_SWITCH_API_URL
MODEL_SWITCH_API_KEY
MODEL_SWITCH_USER
```

## Uninstall

```bash
node uninstall.js            # remove the hooks
node uninstall.js --purge    # also delete the config, state and queue
```

## What your API receives

`POST` to your URL, `Content-Type: application/json`, plus
`Authorization: Bearer <key>` when a key is set.

```json
{
  "userName": "salman",
  "hostname": "DESKTOP-E4M7EU2",
  "platform": "win32",
  "event": "model_switch",
  "source": "hook",
  "fromModel": "claude-opus-5",
  "toModel": "claude-sonnet-5",
  "sessionId": "s-1",
  "at": "2026-09-04T13:44:45.105Z"
}
```

| Field | Notes |
| --- | --- |
| `userName` | From `--user`, or the OS username. |
| `hostname` | Machine name, so you can tell two PCs of the same person apart. |
| `platform` | `win32`, `darwin` or `linux`. |
| `event` | Always `model_switch` today. |
| `source` | `hook` when the switch was applied by Claude Code. `transcript` when it was detected afterwards, which is how automatic downgrades show up. `test` from `test-send.js`. |
| `fromModel` | Previous model. Can be `null` if it was never seen. |
| `toModel` | New model. |
| `sessionId` | Claude Code session id. Use it to dedupe. |
| `at` | When the switch was detected, ISO 8601 UTC. |

Reply with any 2xx status. Anything else counts as a failure and the alert is
queued for retry.

### Example receiver

```js
router.post('/model-switch', express.json(), (req, res) => {
  const { userName, hostname, fromModel, toModel, source, at } = req.body;
  console.log(`${at} ${userName}@${hostname} ${fromModel} -> ${toModel} (${source})`);
  res.sendStatus(200);
});
```

## How it detects a switch

Three hooks are registered.

1. `PostModelSwitch` fires when Claude Code applies a model change. It carries
   `from_model` and `to_model`, so this is the direct signal and it sends the
   alert.
2. `SessionStart` records the model a session begins on. It sends nothing,
   because starting a session is not a switch.
3. `Stop` is the safety net. It reads the last assistant message in the session
   transcript at `~/.claude/projects/<slug>/<session>.jsonl` and compares the
   model against what was recorded. If they differ, it sends an alert with
   `source: "transcript"`. This catches a switch that happened without the hook
   firing, such as an automatic downgrade when a usage limit is hit.

Messages from subagents are skipped, otherwise a subagent running a different
model would look like a switch.

The transcript reading approach is borrowed from
[cc-lens](https://github.com/Arindam200/cc-lens), which reads the same local
files to build its dashboard.

## When your API is down

A failed POST is written to `~/.claude/model-switch-alert/spool.jsonl` and
retried, in order, on the next hook fire. Nothing is lost when a laptop is
offline. The queue holds the most recent 200 alerts.

The hooks run with `async: true` and a 20 second cap, so a slow or unreachable
API never blocks or slows down Claude Code. The script exits 0 no matter what
goes wrong. Failures are logged to `~/.claude/model-switch-alert/error.log`.

## Files it owns

```
~/.claude/settings.json                        the hook entries
~/.claude/model-switch-alert/config.json       apiUrl, apiKey, userName
~/.claude/model-switch-alert/state.json        last known model per session
~/.claude/model-switch-alert/spool.jsonl       failed posts awaiting retry
~/.claude/model-switch-alert/error.log         capped at 256 KB
```

To pause it without uninstalling, set `"enabled": false` in `config.json`.
