#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const rawPayload = process.argv.at(-1);

function shorten(value, maxLength = 180) {
  if (!value) return "";
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function appendLog(line) {
  const logPath = process.env.CODEX_NOTIFY_LOG;
  if (!logPath) return;
  const absolutePath = resolve(logPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  appendFileSync(absolutePath, `${line}\n`, "utf8");
}

let payload = {};
try {
  payload = rawPayload ? JSON.parse(rawPayload) : {};
} catch (error) {
  appendLog(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "failed to parse notify payload",
      rawPayload,
      error: String(error),
    }),
  );
  process.exit(0);
}

const eventType = payload.type || "unknown";
const cwd = payload.cwd || "";
const project = cwd ? basename(cwd) : "Codex";

const eventMap = {
  "agent-turn-complete": {
    title: "Codex finished a task",
    body:
      shorten(payload["last-assistant-message"]) ||
      shorten(payload.summary) ||
      `Turn ${payload["turn-id"] || ""} completed`.trim(),
  },
  "approval-requested": {
    title: "Codex needs approval",
    body:
      shorten(payload.reason) ||
      shorten(payload.command) ||
      `Approval requested in ${project}`,
  },
  "user-input-requested": {
    title: "Codex needs your input",
    body:
      shorten(payload.prompt) ||
      shorten(payload.question) ||
      `Input requested in ${project}`,
  },
};

const details = eventMap[eventType] || {
  title: "Codex update",
  body: shorten(JSON.stringify(payload)),
};

appendLog(
  JSON.stringify({
    ts: new Date().toISOString(),
    type: eventType,
    title: details.title,
    body: details.body,
    cwd,
    turnId: payload["turn-id"] || null,
    threadId: payload["thread-id"] || null,
  }),
);

if (process.env.CODEX_NOTIFY_DISABLE_OSASCRIPT === "1") {
  process.exit(0);
}

const notificationScript =
  `display notification "${escapeAppleScript(details.body)}" ` +
  `with title "${escapeAppleScript(details.title)}" ` +
  `subtitle "${escapeAppleScript(project)}"`;

const result = spawnSync("/usr/bin/osascript", ["-e", notificationScript], {
  stdio: "ignore",
});

if (result.error) {
  appendLog(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "failed to invoke osascript",
      error: String(result.error),
    }),
  );
}
