import fsp from "node:fs/promises";
import net from "node:net";
import { createId, sha256 } from "./ids.js";
import { readRuntimeLock } from "./runtime-lock.js";

export const CONTROL_PROTOCOL_VERSION = 1;
const MAX_CONTROL_BYTES = 64 * 1024;

function safeCode(error) {
  const code = String(error && (error.code || error.message) || "internal_error");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "internal_error";
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function assertCurrentOwnership(layout, ownership) {
  if (!ownership || typeof ownership.instanceId !== "string") throw new Error("control_owner_required");
  let current;
  try { current = await readRuntimeLock(layout); }
  catch { throw new Error("control_owner_lost"); }
  if (!current || current.instanceId !== ownership.instanceId || current.pid !== process.pid) throw new Error("control_owner_lost");
  return current;
}

function sameSocket(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function probeUnixEndpoint(endpoint, timeoutMs = 250) {
  return await new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish("live"), timeoutMs);
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      if (error && ["ENOENT", "ECONNREFUSED"].includes(error.code)) finish("stale");
      else finish("uncertain");
    });
  });
}

export function controlEndpoint(layout, platform = process.platform) {
  if (platform === "win32") return "\\\\.\\pipe\\gorombo-skill-harvester-" + sha256(Buffer.from(layout.productRoot, "utf8")).slice(0, 24);
  return layout.wakeEndpoint;
}

function requestEnvelope(command, payload) {
  if (typeof command !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(command)) throw new Error("control_command_invalid");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("control_payload_invalid");
  return { version: CONTROL_PROTOCOL_VERSION, requestId: createId("run"), command, payload };
}

function validateRequest(value) {
  if (!exactKeys(value, ["command", "payload", "requestId", "version"])) throw new Error("control_request_invalid");
  if (value.version !== CONTROL_PROTOCOL_VERSION || typeof value.requestId !== "string" || !/^run_[a-f0-9]{32}$/u.test(value.requestId)) throw new Error("control_request_invalid");
  if (typeof value.command !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value.command)) throw new Error("control_request_invalid");
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("control_request_invalid");
  return value;
}

function validateResponse(value, requestId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== CONTROL_PROTOCOL_VERSION || value.requestId !== requestId || typeof value.ok !== "boolean") throw new Error("control_response_invalid");
  if (value.ok) {
    if (!exactKeys(value, ["version", "requestId", "ok", "result"])) throw new Error("control_response_invalid");
    return { ok: true, result: value.result };
  }
  if (!exactKeys(value, ["version", "requestId", "ok", "error"]) || !exactKeys(value.error, ["code"]) || !/^[a-z][a-z0-9_]{0,63}$/u.test(String(value.error.code || ""))) throw new Error("control_response_invalid");
  return { ok: false, code: value.error.code };
}

export class ControlServer {
  constructor(layout, handler, options = {}) {
    this.layout = layout;
    this.handler = handler;
    this.ownership = options.ownership || null;
    this.platform = options.platform || process.platform;
    this.endpoint = options.endpoint || controlEndpoint(layout, this.platform);
    this.probeEndpoint = options.probeEndpoint || probeUnixEndpoint;
    this.server = null;
    this.sockets = new Set();
    this.ownsEndpoint = false;
    this.endpointStat = null;
  }

  async start() {
    if (this.server) return this.endpoint;
    await assertCurrentOwnership(this.layout, this.ownership);
    if (this.platform !== "win32") {
      let existing = null;
      try { existing = await fsp.lstat(this.endpoint); }
      catch (error) { if (!error || error.code !== "ENOENT") throw error; }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isSocket()) throw new Error("control_endpoint_unsafe");
        const state = await this.probeEndpoint(this.endpoint);
        if (state === "live") throw new Error("control_endpoint_busy");
        if (state !== "stale") throw new Error("control_endpoint_uncertain");
        await assertCurrentOwnership(this.layout, this.ownership);
        const unchanged = await fsp.lstat(this.endpoint);
        if (!unchanged.isSocket() || unchanged.isSymbolicLink() || !sameSocket(existing, unchanged)) throw new Error("control_endpoint_changed");
        await fsp.unlink(this.endpoint);
      }
    }
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      this.#handle(socket);
    });
    server.on("error", function () {});
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { server.removeListener("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.endpoint);
    });
    try {
      await assertCurrentOwnership(this.layout, this.ownership);
      if (this.platform !== "win32") {
        await fsp.chmod(this.endpoint, 0o600);
        this.endpointStat = await fsp.lstat(this.endpoint);
        if (!this.endpointStat.isSocket() || this.endpointStat.isSymbolicLink()) throw new Error("control_endpoint_unsafe");
      }
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (this.platform !== "win32") {
        try { await fsp.unlink(this.endpoint); } catch {}
      }
      throw error;
    }
    this.server = server;
    this.ownsEndpoint = true;
    return this.endpoint;
  }

  #handle(socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    let requestId = null;
    const finish = (value) => {
      if (socket.destroyed) return;
      socket.end(JSON.stringify(value) + "\n");
    };
    socket.on("data", async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_BYTES) {
        handled = true;
        finish({ version: CONTROL_PROTOCOL_VERSION, requestId, ok: false, error: { code: "control_request_too_large" } });
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      handled = true;
      try {
        const request = validateRequest(JSON.parse(buffer.slice(0, index).replace(/\r$/u, "")));
        requestId = request.requestId;
        const result = await this.handler(request.command, request.payload);
        finish({ version: CONTROL_PROTOCOL_VERSION, requestId, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        finish({ version: CONTROL_PROTOCOL_VERSION, requestId, ok: false, error: { code: safeCode(error) } });
      }
    });
    socket.on("error", function () {});
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (this.platform !== "win32" && this.ownsEndpoint && this.endpointStat) {
      let mayRemove = false;
      try {
        await assertCurrentOwnership(this.layout, this.ownership);
        const current = await fsp.lstat(this.endpoint);
        mayRemove = current.isSocket() && !current.isSymbolicLink() && sameSocket(current, this.endpointStat);
      } catch {}
      if (mayRemove) await fsp.unlink(this.endpoint);
    }
    this.endpointStat = null;
    this.ownsEndpoint = false;
  }
}

export async function sendControlCommand(layout, command, payload = {}, options = {}) {
  const envelope = requestEnvelope(command, payload);
  const endpoint = options.endpoint || controlEndpoint(layout, options.platform || process.platform);
  const timeoutMs = options.timeoutMs || 5000;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("control_timeout")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(envelope) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_CONTROL_BYTES) return finish(new Error("control_response_too_large"));
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      let response;
      try { response = validateResponse(JSON.parse(buffer.slice(0, index).replace(/\r$/u, "")), envelope.requestId); }
      catch { return finish(new Error("control_response_invalid")); }
      if (!response.ok) return finish(new Error(response.code));
      finish(null, response.result);
    });
    socket.on("end", () => finish(new Error("runtime_unavailable")));
    socket.on("close", () => finish(new Error("runtime_unavailable")));
    socket.on("error", () => finish(new Error("runtime_unavailable")));
  });
}
