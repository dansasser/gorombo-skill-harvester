import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildCodexInvocation, resolveVerifiedCodexLaunchPlan } from "./codex-launcher.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_QUEUED_NOTIFICATIONS = 256;

export class AppServerError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "AppServerError";
    this.code = code;
    this.requestWritten = Boolean(options.requestWritten);
    this.rpcCode = options.rpcCode === undefined ? null : options.rpcCode;
    this.rpcMessage = typeof options.rpcMessage === "string" ? options.rpcMessage.slice(0, 2000) : "";
  }
}

function safeEnvironment(extra) {
  const source = { ...process.env, ...(extra || {}) };
  const env = {};
  const allowed = new Set([
    "PATH", "Path", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SYSTEMROOT", "SystemRoot",
    "WINDIR", "ComSpec", "PATHEXT", "HOMEDRIVE", "HOMEPATH", "USERNAME", "CODEX_HOME"
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(key) || /^(?:OPENAI|CODEX)_[A-Z0-9_]+$/u.test(key)) env[key] = value;
  }
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_ALLOWED_USER_IDS;
  return env;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeNotification(method, params) {
  if (method !== "turn/completed") return null;
  const turn = object(params && params.turn) ? params.turn : null;
  const threadId = typeof (params && params.threadId) === "string"
    ? params.threadId
    : turn && typeof turn.threadId === "string"
      ? turn.threadId
      : null;
  const turnId = turn && typeof turn.id === "string" ? turn.id : null;
  const status = turn && typeof turn.status === "string"
    ? turn.status
    : turn && object(turn.status) && typeof turn.status.type === "string"
      ? turn.status.type
      : null;
  if (!threadId || !turnId || !status || threadId.length > 256 || turnId.length > 256 || status.length > 64) throw new AppServerError("app_server_protocol_invalid", { requestWritten: true });
  return { method, params: { threadId, turn: { id: turnId, status } } };
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.executable = options.executable;
    this.launchPlan = options.launchPlan || null;
    this.cwd = options.cwd || process.cwd();
    this.env = safeEnvironment(options.env);
    this.spawn = options.spawn || spawn;
    this.launcherSpawn = options.launcherSpawn;
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.child = null;
    this.startPromise = null;
    this.started = false;
    this.closed = false;
    this.nextId = 1;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.pending = new Map();
    this.notifications = [];
    this.waiters = new Set();
  }

  async start() {
    if (this.started) return this;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.#start();
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }

  async #start() {
    if (this.closed) throw new AppServerError("connection_closed");
    if (!this.launchPlan) {
      try {
        this.launchPlan = (await resolveVerifiedCodexLaunchPlan({
          executable: this.executable,
          env: this.env,
          spawn: this.launcherSpawn,
          cwd: this.cwd
        })).plan;
      } catch {
        throw new AppServerError("connection_unavailable");
      }
    }
    const invocation = buildCodexInvocation(this.launchPlan, ["app-server", "--stdio"]);
    try {
      this.child = this.spawn(invocation.command, invocation.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      throw new AppServerError("connection_unavailable");
    }
    const child = this.child;
    child.stdout.on("data", (chunk) => this.#receive(chunk));
    child.stderr.on("data", function () {});
    child.on("error", () => this.#failAll(new AppServerError("connection_unavailable")));
    child.on("close", () => {
      if (this.child === child) {
        this.child = null;
        this.started = false;
        this.#failAll(new AppServerError("connection_closed", { requestWritten: true }));
      }
    });
    try {
      await this.#request("initialize", {
        clientInfo: { name: "gorombo-skill-harvester", title: "Gorombo Skill Harvester", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      }, {});
      this.#notify("initialized", {});
      this.started = true;
      return this;
    } catch (error) {
      if (this.child && !this.child.killed) this.child.kill();
      throw error;
    }
  }

  #receive(chunk) {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.#protocolFailure("app_server_line_too_large");
      return;
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.#protocolFailure("app_server_line_too_large");
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#protocolFailure("app_server_protocol_invalid");
        return;
      }
      if (!object(message) || message.jsonrpc !== "2.0") {
        this.#protocolFailure("app_server_protocol_invalid");
        return;
      }
      if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        this.pending.delete(String(message.id));
        clearTimeout(pending.timer);
        if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        if (Object.hasOwn(message, "error")) {
          const error = object(message.error) ? message.error : {};
          pending.reject(new AppServerError("rpc_error", {
            requestWritten: pending.written,
            rpcCode: error.code,
            rpcMessage: typeof error.message === "string" ? error.message : ""
          }));
        } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
        else pending.reject(new AppServerError("app_server_protocol_invalid", { requestWritten: pending.written }));
      } else if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
        try {
          const notification = safeNotification(message.method, object(message.params) ? message.params : {});
          if (notification) this.#pushNotification(notification);
        } catch (error) {
          this.#protocolFailure(error.code || "app_server_protocol_invalid");
          return;
        }
      } else if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
        this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client request not supported" } });
      } else this.#protocolFailure("app_server_protocol_invalid");
    }
  }

  #protocolFailure(code) {
    this.#failAll(new AppServerError(code, { requestWritten: true }));
    if (this.child && !this.child.killed) this.child.kill();
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new AppServerError(error.code, { requestWritten: pending.written || error.requestWritten }));
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  #write(message) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) throw new AppServerError("connection_unavailable");
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new AppServerError("app_server_request_too_large");
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      throw new AppServerError("connection_unavailable");
    }
  }

  #notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async #request(method, params, options) {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const key = String(id);
      const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
      const pending = { resolve, reject, written: false, signal: options.signal || null, abort: null, timer: null };
      pending.timer = setTimeout(() => {
        if (!this.pending.delete(key)) return;
        if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        reject(new AppServerError("request_timeout", { requestWritten: pending.written }));
      }, timeoutMs);
      if (pending.signal) {
        pending.abort = () => {
          if (!this.pending.delete(key)) return;
          clearTimeout(pending.timer);
          reject(new AppServerError("request_aborted", { requestWritten: pending.written }));
        };
        if (pending.signal.aborted) return pending.abort();
        pending.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(key, pending);
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
        pending.written = true;
      } catch (error) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
        reject(error);
      }
    });
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    return await this.#request(method, params, options);
  }

  #pushNotification(notification) {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(notification)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(notification);
      return;
    }
    this.notifications.push(notification);
    if (this.notifications.length > MAX_QUEUED_NOTIFICATIONS) this.notifications.shift();
  }

  async waitForNotification(predicate, options = {}) {
    if (typeof predicate !== "function") throw new AppServerError("notification_predicate_invalid");
    const index = this.notifications.findIndex(predicate);
    if (index >= 0) return this.notifications.splice(index, 1)[0];
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    return await new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, signal: options.signal || null, abort: null, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
        reject(new AppServerError("notification_timeout", { requestWritten: true }));
      }, timeoutMs);
      if (waiter.signal) {
        waiter.abort = () => {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          reject(new AppServerError("request_aborted", { requestWritten: true }));
        };
        if (waiter.signal.aborted) return waiter.abort();
        waiter.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.started = false;
    this.#failAll(new AppServerError("connection_closed"));
    if (child && !child.killed) child.kill();
  }
}
