#!/usr/bin/env node

import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const HOST = "127.0.0.1";
const PENDING_POLL_INTERVAL_MS = 1000;
const SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);
const PLAIN_CODEX_SUBCOMMANDS = new Set([
  "exec",
  "review",
  "login",
  "logout",
  "mcp",
  "mcp-server",
  "app-server",
  "app",
  "completion",
  "sandbox",
  "debug",
  "apply",
  "cloud",
  "features",
]);

function logEvent(event) {
  const logPath = process.env.CODEX_GHOSTTY_NOTIFY_LOG;
  if (!logPath) return;
  const absolutePath = resolve(logPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  appendFileSync(
    absolutePath,
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}

function getFirstArg(args) {
  for (const arg of args) {
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

function shouldFallbackToPlainCodex(args) {
  if (args.includes("--remote")) return true;
  if (args.includes("--help") || args.includes("-h")) return true;
  const firstArg = getFirstArg(args);
  return firstArg ? PLAIN_CODEX_SUBCOMMANDS.has(firstArg) : false;
}

function spawnPlainCodex(args) {
  const child = spawn(CODEX_BIN, args, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function runAppleScript(lines) {
  const result = spawnSync("/usr/bin/osascript", lines.flatMap((line) => ["-e", line]), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    logEvent({
      level: "warn",
      kind: "applescript_failed",
      stderr: (result.stderr || "").trim(),
      stdout: (result.stdout || "").trim(),
    });
    return null;
  }
  return (result.stdout || "").trim();
}

function getGhosttyContext() {
  const output = runAppleScript([
    'tell application "Ghostty"',
    'if not frontmost then return "frontmost=false"',
    "set w to front window",
    "set t to selected tab of w",
    'return "frontmost=true;windowId=" & (id of w) & ";tabId=" & (id of t) & ";tabName=" & (name of t)',
    "end tell",
  ]);
  if (!output) return null;
  const state = {};
  for (const part of output.split(";")) {
    const [key, ...rest] = part.split("=");
    state[key] = rest.join("=");
  }
  return {
    frontmost: state.frontmost === "true",
    windowId: state.windowId || null,
    tabId: state.tabId || null,
    tabName: state.tabName || null,
  };
}

function emitNotificationPayload(payload) {
  const notifyScriptPath = resolve(__dirname, "codex-notify.mjs");
  spawnSync("node", [notifyScriptPath, JSON.stringify(payload)], {
    stdio: "ignore",
    env: process.env,
  });
  logEvent({
    kind: "notification_sent",
    payload,
  });
}

function summarizePermissions(permissions) {
  if (!permissions) return "Additional permissions requested";
  const segments = [];
  if (permissions.network?.enabled) segments.push("network access");
  const readCount = permissions.fileSystem?.read?.length || 0;
  const writeCount = permissions.fileSystem?.write?.length || 0;
  if (readCount) segments.push(`read access to ${readCount} path${readCount === 1 ? "" : "s"}`);
  if (writeCount) segments.push(`write access to ${writeCount} path${writeCount === 1 ? "" : "s"}`);
  return segments.length ? segments.join(", ") : "Additional permissions requested";
}

function summarizeUserInput(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return "Codex is waiting for your input";
  }
  const [question] = questions;
  return question.question || question.header || "Codex is waiting for your input";
}

function buildPendingRequest(method, params, launchCwd) {
  const cwd = params.cwd || launchCwd;
  if (method === "item/commandExecution/requestApproval") {
    return {
      type: "approval-requested",
      "thread-id": params.threadId,
      "turn-id": params.turnId,
      cwd,
      command: params.command || null,
      reason: params.reason || null,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      type: "approval-requested",
      "thread-id": params.threadId,
      "turn-id": params.turnId,
      cwd,
      reason:
        params.reason ||
        (params.grantRoot
          ? `File changes require approval under ${params.grantRoot}`
          : "File changes require approval"),
    };
  }

  if (method === "item/permissions/requestApproval") {
    return {
      type: "approval-requested",
      "thread-id": params.threadId,
      "turn-id": params.turnId,
      cwd,
      reason: params.reason || summarizePermissions(params.permissions),
    };
  }

  if (method === "item/tool/requestUserInput") {
    return {
      type: "user-input-requested",
      "thread-id": params.threadId,
      "turn-id": params.turnId,
      cwd,
      prompt: summarizeUserInput(params.questions),
    };
  }

  return null;
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("failed to allocate a TCP port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePort, rejectPort) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: HOST, port }, () => {
        socket.destroy();
        resolvePort();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          rejectPort(new Error(`timed out waiting for ${HOST}:${port}`));
          return;
        }
        setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  push(chunk, onFrame) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const raw = this.buffer.readBigUInt64BE(2);
        if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("websocket frame is too large");
        }
        length = Number(raw);
        offset = 10;
      }

      const maskLength = masked ? 4 : 0;
      const frameLength = offset + maskLength + length;
      if (this.buffer.length < frameLength) return;

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      let payload = this.buffer.subarray(offset + maskLength, frameLength);
      if (masked && mask) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      } else {
        payload = Buffer.from(payload);
      }

      this.buffer = this.buffer.subarray(frameLength);

      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const joined = Buffer.concat(this.fragments);
        const messageOpcode = this.fragmentOpcode ?? 0x1;
        this.fragments = [];
        this.fragmentOpcode = null;
        onFrame({ opcode: messageOpcode, payload: joined });
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
          continue;
        }
        onFrame({ opcode, payload });
        continue;
      }

      onFrame({ opcode, payload });
    }
  }
}

class CodexAppServerProxy {
  constructor({ backendUrl, launchTabId, launchCwd }) {
    this.backendUrl = backendUrl;
    this.launchTabId = launchTabId;
    this.launchCwd = launchCwd;
    this.pendingRequests = new Map();
    this.pollTimer = null;
    this.server = null;
    this.clientSocket = null;
    this.backend = null;
    this.backendOpen = false;
    this.clientQueue = [];
    this.closed = false;
  }

  async listen(port) {
    this.server = http.createServer();
    this.server.on("upgrade", (request, socket) => {
      if (this.clientSocket) {
        socket.end("HTTP/1.1 503 Busy\r\n\r\n");
        return;
      }
      this.handleUpgrade(request, socket);
    });

    await new Promise((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(port, HOST, resolveListen);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopPendingPoll();
    try {
      this.backend?.close();
    } catch {}
    try {
      this.clientSocket?.destroy();
    } catch {}
    await new Promise((resolveClose) => {
      if (!this.server) {
        resolveClose();
        return;
      }
      this.server.close(() => resolveClose());
    });
  }

  handleUpgrade(request, socket) {
    const key = request.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );

    socket.setNoDelay(true);
    this.clientSocket = socket;
    const parser = new FrameParser();

    socket.on("data", (chunk) => {
      parser.push(chunk, (frame) => this.handleClientFrame(frame));
    });

    socket.on("close", () => {
      this.close();
    });

    socket.on("error", (error) => {
      logEvent({ level: "warn", kind: "client_socket_error", message: String(error) });
      this.close();
    });

    this.backend = new WebSocket(this.backendUrl);
    this.backend.binaryType = "arraybuffer";

    this.backend.addEventListener("open", () => {
      this.backendOpen = true;
      for (const pending of this.clientQueue) {
        this.backend.send(pending);
      }
      this.clientQueue = [];
    });

    this.backend.addEventListener("message", (event) => {
      const raw = this.normalizeBackendData(event.data);
      if (typeof raw === "string") {
        this.inspectBackendMessage(raw);
        socket.write(encodeFrame(0x1, Buffer.from(raw)));
        return;
      }
      socket.write(encodeFrame(0x2, raw));
    });

    this.backend.addEventListener("close", () => {
      this.close();
    });

    this.backend.addEventListener("error", (error) => {
      logEvent({ level: "warn", kind: "backend_socket_error", message: String(error) });
      this.close();
    });
  }

  normalizeBackendData(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return Buffer.from([]);
  }

  handleClientFrame(frame) {
    if (frame.opcode === 0x8) {
      this.close();
      return;
    }

    if (frame.opcode === 0x9 && this.clientSocket) {
      this.clientSocket.write(encodeFrame(0xA, frame.payload));
      return;
    }

    if (frame.opcode !== 0x1 && frame.opcode !== 0x2) return;

    const payload = frame.opcode === 0x1 ? frame.payload.toString("utf8") : frame.payload;
    if (!this.backendOpen) {
      this.clientQueue.push(payload);
      return;
    }
    this.backend.send(payload);
  }

  inspectBackendMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      this.handleEnvelope(message);
    }
  }

  handleEnvelope(message) {
    if (!message || typeof message !== "object") return;
    if (SERVER_REQUEST_METHODS.has(message.method)) {
      const key = String(message.id);
      const payload = buildPendingRequest(message.method, message.params || {}, this.launchCwd);
      if (!payload) return;
      this.pendingRequests.set(key, {
        id: key,
        payload,
        notified: false,
      });
      this.ensurePendingPoll();
      this.flushPendingNotifications();
      return;
    }

    if (message.method === "serverRequest/resolved") {
      const key = String(message.params?.requestId);
      this.pendingRequests.delete(key);
      if (this.pendingRequests.size === 0) this.stopPendingPoll();
    }
  }

  ensurePendingPoll() {
    if (this.pollTimer || this.pendingRequests.size === 0) return;
    this.pollTimer = setInterval(() => {
      this.flushPendingNotifications();
    }, PENDING_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stopPendingPoll() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  flushPendingNotifications() {
    if (this.pendingRequests.size === 0) return;
    const context = getGhosttyContext();
    const launchTabIsActive = context?.frontmost && context?.tabId === this.launchTabId;

    if (launchTabIsActive) return;

    for (const pending of this.pendingRequests.values()) {
      if (pending.notified) continue;
      emitNotificationPayload(pending.payload);
      pending.notified = true;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (shouldFallbackToPlainCodex(args)) {
    spawnPlainCodex(args);
    return;
  }

  const launchContext = getGhosttyContext();
  if (!launchContext?.tabId) {
    logEvent({
      level: "warn",
      kind: "ghostty_context_unavailable",
      termProgram: process.env.TERM_PROGRAM || null,
    });
    spawnPlainCodex(args);
    return;
  }

  const backendPort = await getFreePort();
  const proxyPort = await getFreePort();
  const backendUrl = `ws://${HOST}:${backendPort}`;
  const proxyUrl = `ws://${HOST}:${proxyPort}`;

  const appServer = spawn(
    CODEX_BIN,
    ["app-server", "--listen", backendUrl, "--session-source", "cli"],
    {
      stdio: "ignore",
      env: process.env,
    },
  );

  const proxy = new CodexAppServerProxy({
    backendUrl,
    launchTabId: launchContext.tabId,
    launchCwd: process.cwd(),
  });

  const cleanup = async (code = 0, signal = null) => {
    await proxy.close();
    if (!appServer.killed) {
      appServer.kill("SIGTERM");
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code);
  };

  process.on("SIGINT", () => cleanup(130));
  process.on("SIGTERM", () => cleanup(143));

  try {
    await waitForPort(backendPort);
    await proxy.listen(proxyPort);
  } catch (error) {
    logEvent({
      level: "error",
      kind: "proxy_start_failed",
      message: String(error),
    });
    try {
      appServer.kill("SIGTERM");
    } catch {}
    spawnPlainCodex(args);
    return;
  }

  const clientArgs = [
    "--remote",
    proxyUrl,
    "-c",
    "tui.notifications=[]",
    ...args,
  ];

  const client = spawn(CODEX_BIN, clientArgs, {
    stdio: "inherit",
    env: process.env,
  });

  client.on("exit", (code, signal) => {
    cleanup(code ?? 0, signal);
  });

  appServer.on("exit", (code, signal) => {
    logEvent({
      level: "warn",
      kind: "app_server_exit",
      code,
      signal,
    });
    if (!client.killed) {
      client.kill("SIGTERM");
    }
  });
}

main().catch((error) => {
  logEvent({
    level: "error",
    kind: "wrapper_crash",
    message: String(error),
  });
  spawnPlainCodex(process.argv.slice(2));
});
