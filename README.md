# Codex CLI macOS Notifier

macOS desktop notifications for Codex CLI, focused on the two moments that matter most in day-to-day use:

- a turn finishes
- Codex needs your approval or manual input

Chinese version:

- [README.zh-CN.md](./README.zh-CN.md)
- [IMPLEMENTATION_NOTES.zh-CN.md](./IMPLEMENTATION_NOTES.zh-CN.md)

## What this project does

This project combines two notification paths because current Codex CLI behavior is split:

- `agent-turn-complete` is available through the official `notify` hook.
- `approval-requested` and `user-input-requested` are exposed through the TUI notification channel, not the `notify` hook.

So the implementation uses a hybrid design:

- `codex-notify.mjs` handles completed-turn events and forwards them to macOS Notification Center with `osascript`.
- Codex TUI config handles approval and input prompts when the terminal window is not focused.

## Repository contents

- `codex-notify.mjs`
  Receives the JSON payload from Codex, normalizes the event, appends an optional local log, and sends a macOS notification.
- `codex-with-notify`
  A wrapper that starts `codex` with the required config overrides.
- `codex-ghostty-notify`
  A Ghostty-specific wrapper for interactive Codex sessions. It tracks the launching Ghostty tab and sends notifications when approval or input requests stay pending while you are no longer on that tab.
- `codex-ghostty-notify.mjs`
  A local WebSocket proxy that sits between `codex --remote` and a local `codex app-server`, intercepts approval events, and applies Ghostty tab-aware notification rules.
- `IMPLEMENTATION_NOTES.md`
  Design summary, tradeoffs, validation method, and lessons learned.

## How it works

### 1. Turn completion notifications

Codex can invoke an external program via its `notify` setting. The program receives a JSON payload describing the finished turn. This project uses:

```toml
notify = ["node", "/path/to/codex-notify.mjs"]
```

The script then:

1. parses the event payload
2. extracts a concise title and body
3. optionally writes a JSON line to a local log
4. calls `/usr/bin/osascript` to show a native macOS notification

### 2. Approval and input notifications

Current Codex builds surface these through TUI notifications. This project enables:

```toml
[tui]
notifications = ["approval-requested", "user-input-requested"]
notification_method = "auto"
```

This means:

- if the terminal is unfocused, macOS can surface a notification through the terminal app
- if the terminal is focused, the prompt appears inline and no extra alert is needed

## Installation

### Use the wrapper

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-with-notify
```

Or pass a prompt:

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-with-notify "explain this repo"
```

### Use the Ghostty tab-aware wrapper

If you use Ghostty and want approval notifications even when Ghostty itself is still frontmost but you switched to another tab, use:

```bash
/Users/liufei/Downloads/codex-desktop-notify/codex-ghostty-notify
```

Optional alias:

```bash
alias cg='/Users/liufei/Downloads/codex-desktop-notify/codex-ghostty-notify'
```

Then start interactive Codex with:

```bash
cg
```

This wrapper:

- starts a local `codex app-server`
- starts `codex --remote` against a local proxy
- captures approval and user-input requests from the app-server protocol
- checks the currently selected Ghostty tab through AppleScript
- sends a macOS notification whenever the request is still pending and you are no longer on the launching tab

Plain `codex` is unchanged. It keeps the previous behavior.

### Use global Codex config

If you want plain `codex` to always notify, add this to `~/.codex/config.toml`:

```toml
notify = ["node", "/Users/liufei/Downloads/codex-desktop-notify/codex-notify.mjs"]

[tui]
notifications = ["approval-requested", "user-input-requested"]
notification_method = "auto"
```

## Validation

### Completion hook smoke test

```bash
CODEX_NOTIFY_LOG=/tmp/codex-notify.log \
CODEX_NOTIFY_DISABLE_OSASCRIPT=1 \
node /Users/liufei/Downloads/codex-desktop-notify/codex-notify.mjs \
  '{"type":"agent-turn-complete","turn-id":"demo-1","cwd":"/Users/liufei/Downloads","last-assistant-message":"Done."}'
```

Expected result:

- one JSON log line is appended to `/tmp/codex-notify.log`
- the event type is `agent-turn-complete`

### Real CLI validation

Run:

```bash
CODEX_NOTIFY_LOG=/tmp/codex-notify.log codex
```

Then:

- trigger a normal task and switch away from the terminal before the turn ends
- trigger a command that needs approval and switch away before the approval prompt appears

Expected result:

- completed turns notify through the hook script
- approval and input requests notify through the TUI channel

## Limits

- `approval-requested` currently does not reach the `notify` hook, so approvals cannot yet be handled by the same script path as completions.
- approval notifications depend on terminal and macOS notification support while the terminal is unfocused.
- `codex-ghostty-notify` already uses a local `app-server` bridge for interactive Ghostty sessions, but plain `codex` still follows the simpler hook plus TUI design.
- if you want the same tab-aware behavior in terminals other than Ghostty, the next step is a generalized `app-server` bridge that can detect session focus outside Ghostty.
- `codex-ghostty-notify` is designed for interactive Ghostty sessions. For non-interactive commands such as `codex exec`, it falls back to plain `codex`.
- the Ghostty wrapper relies on Ghostty AppleScript support. In Ghostty this is controlled by `macos-applescript`, which defaults to `true`.
