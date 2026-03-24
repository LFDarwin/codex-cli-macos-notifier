# Implementation Notes

## Summary of the change

This project now has two layers:

- a base Codex CLI notifier for macOS
- an optional Ghostty-specific wrapper for tab-aware approval notifications

The base layer solves the broad problem:

- when Codex finishes a task, the user should be notified even if the terminal is in the background
- when Codex needs approval or additional user input, the user should also be notified instead of missing the prompt

The Ghostty wrapper solves a narrower problem that the base layer cannot cover by itself:

- if Ghostty is still the frontmost app, but the user has switched to another tab, approval prompts should still trigger a desktop notification

## Method

### Base layer: official hook path for completed turns

The official `notify` config path is the cleanest option for completed turns. It lets Codex execute a local program after a turn completes and passes a JSON payload to that program. The local script can then decide how to present the event.

In this project, the hook target is `codex-notify.mjs`.

Its job is intentionally small:

1. accept the raw payload
2. parse it safely
3. derive a short title and body
4. optionally append a machine-readable local log
5. call `osascript` to send a native macOS desktop notification

### Base layer: TUI notification path for approvals

Approval and user-input requests do not currently come through the same hook path. The practical workaround is to enable Codex TUI notifications for:

- `approval-requested`
- `user-input-requested`

That is enough to cover the interactive CLI cases where the terminal itself is not focused.

### Ghostty extension: local app-server bridge plus tab detection

Ghostty exposed a gap in the base design. Codex TUI notifications use unfocused-terminal semantics, not unfocused-tab semantics. If Ghostty stays frontmost and the user switches to another tab in the same window, the default TUI path is too coarse.

To solve that case, this project adds `codex-ghostty-notify` and `codex-ghostty-notify.mjs`.

The wrapper does four things:

1. records the Ghostty tab that launched the Codex session
2. starts a local `codex app-server`
3. inserts a local WebSocket proxy between `codex --remote` and that app-server
4. watches approval and user-input requests directly from the app-server protocol

While a request is still pending, the wrapper polls Ghostty through AppleScript. If the selected tab is no longer the launch tab, it emits a native macOS notification through the same `codex-notify.mjs` script.

This keeps plain `codex` untouched and puts the stronger behavior behind an explicit wrapper command.

## Why this design is correct

The main design choice was not technical purity but event coverage with low operational risk.

- if we used only the official `notify` hook, task completion would work but approval prompts would be missed
- if we relied only on TUI notifications, completion behavior would be weaker and approval behavior would still be too coarse for Ghostty multi-tab workflows
- combining a small hook, the built-in TUI path, and an optional Ghostty-specific bridge gives the broadest coverage without changing plain `codex`

So the final design is a coverage-first design with an opt-in extension for the one workflow where the default semantics are insufficient.

## Validation approach

Four levels of validation were used:

1. direct script validation
   Feed a synthetic JSON payload into `codex-notify.mjs` and verify it logs the expected normalized event.
2. macOS notification smoke test
   Invoke the script without disabling `osascript` and verify the desktop notification appears.
3. wrapper syntax and fallback validation
   Check `codex-ghostty-notify.mjs` with `node --check` and confirm that non-interactive or unsupported invocations fall back to plain `codex`.
4. protocol and integration validation
   Confirm from the local Codex JSON schema that approval and input requests are exposed through `app-server` server-request events, and confirm from Ghostty's local scripting definition that the selected-tab state is queryable through AppleScript.

The last step is important because sandboxed automation limits prevented a full end-to-end Ghostty AppleScript test in this environment. The runtime design was therefore validated partly through local protocol inspection and local application dictionaries.

## Lessons learned

### 1. Prompting a model to "ask me for approval" is not the same as a CLI approval event

This was the most important operational lesson. A natural-language response such as "Do you approve this command?" is just assistant output. It is not the same as Codex emitting a real approval request through its runtime.

Testing must force a genuine command execution path that requires approval.

### 2. Event semantics matter more than UI appearance

Two screens can look similar while coming from completely different runtime paths. For notification tooling, that difference is everything. The code must be attached to the runtime event, not to a visually similar message.

### 3. Focus semantics matter too

"Terminal is unfocused" and "the active tab is not this session" are different conditions. Ghostty made that distinction concrete. Once the requirement became tab-aware rather than app-aware, the built-in TUI notification path was no longer sufficient.

### 4. The best implementation is sometimes layered

It is tempting to search for a single hook that handles everything. In practice, the stable solution was a layered one:

- official `notify` hook for completed turns
- built-in TUI notifications for general approval coverage
- an app-server bridge only where stricter focus detection is needed

### 5. Logging is worth keeping even in a small utility

The optional `CODEX_NOTIFY_LOG` and `CODEX_GHOSTTY_NOTIFY_LOG` paths make debugging much easier. Without them, there is no easy way to distinguish:

- no event was emitted
- the event was emitted but the bridge or script failed
- the script succeeded but macOS suppressed the notification

## Recommended future improvement

The Ghostty wrapper solves the tab-awareness problem for Ghostty, but the broader next step would be a terminal-agnostic focus bridge. That would keep the same app-server event strategy while swapping the focus-detection backend so it can work with other terminal apps too.

From there, the same normalized event pipeline could later be extended to:

- Slack
- iPhone push
- richer interactive approval UX
