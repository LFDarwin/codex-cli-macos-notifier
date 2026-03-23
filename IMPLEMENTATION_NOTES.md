# Implementation Notes

## Summary of the change

This project was built to solve a specific workflow problem in Codex CLI on macOS:

- when Codex finishes a task, the user should be notified even if the terminal is in the background
- when Codex needs approval or additional user input, the user should also be notified instead of missing the prompt

The implementation ended up as a hybrid because Codex exposes these events through two different mechanisms.

## Method

### Official hook path

The official `notify` config path is the cleanest option for completed turns. It lets Codex execute a local program after a turn completes and passes a JSON payload to that program. The local script can then decide how to present the event.

In this project, the hook target is `codex-notify.mjs`.

Its job is intentionally small:

1. accept the raw payload
2. parse it safely
3. derive a short title and body
4. optionally append a machine-readable local log
5. call `osascript` to send a native macOS desktop notification

### TUI notification path

Approval and user-input requests do not currently come through the same hook path. The practical workaround is to enable Codex TUI notifications for:

- `approval-requested`
- `user-input-requested`

That is enough to cover the interactive cases the user cares about in the CLI, especially when the terminal is not focused.

## Why this design is correct

The main design choice was not technical preference but event coverage.

- if we used only the official `notify` hook, task completion would work but approval prompts would be missed
- if we relied only on terminal notifications, completion behavior would be weaker and harder to customize
- combining both gives the broadest coverage with the least invasive setup

So the final design is a coverage-first design, not a purity-first design.

## Validation approach

Three levels of validation were used:

1. direct script validation
   Feed a synthetic JSON payload into `codex-notify.mjs` and verify it logs the expected normalized event.
2. macOS notification smoke test
   Invoke the script without disabling `osascript` and verify the desktop notification appears.
3. CLI behavior validation
   Use Codex in real interactive mode and check that:
   - completed turns go through the hook path
   - approval and input prompts surface through the TUI path when the terminal is unfocused

## Lessons learned

### 1. Prompting a model to "ask me for approval" is not the same as a CLI approval event

This was the most important operational lesson. A natural-language response such as "Do you approve this command?" is just assistant output. It is not the same as Codex emitting a real approval request through its runtime.

Testing must force a genuine command execution path that requires approval.

### 2. Event semantics matter more than UI appearance

Two screens can look similar while coming from completely different runtime paths. For notification tooling, that difference is everything. The code must be attached to the runtime event, not to a visually similar message.

### 3. The best implementation is sometimes a composed one

It is tempting to search for a single hook that handles everything. In practice, the stable solution was to combine the strongest official mechanism for completion with the strongest available TUI mechanism for approvals.

### 4. Logging is worth keeping even in a small utility

The optional `CODEX_NOTIFY_LOG` path makes debugging much easier. Without it, there is no easy way to distinguish:

- no event was emitted
- the event was emitted but the script failed
- the script succeeded but macOS suppressed the notification

## Recommended future improvement

If approval notifications need to be as robust and customizable as completion notifications, the next iteration should use Codex `app-server` events and a local bridge process. That would allow both completion and approval events to be normalized through one pipeline and could later be extended to:

- Slack
- iPhone push
- richer interactive approval UX
