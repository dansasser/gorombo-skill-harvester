import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PRODUCT_VERSION, SCHEMA_VERSION } from "./constants.js";
import { createId } from "./ids.js";

const MAX_OWNERSHIP_BYTES = 16 * 1024;
const DEFAULT_STALE_MS = 120_000;

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(code);
}
function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameOwner(left, right) {
  return Boolean(left && right &&
    left.instanceId === right.instanceId &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.packageVersion === right.packageVersion &&
    left.protocolVersion === right.protocolVersion &&
    left.startedAt === right.startedAt);
}

async function readPrivateJson(file, code) {
  const info = await fsp.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_OWNERSHIP_BYTES) throw new Error(code);
  let value;
  try { value = JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { throw new Error(code); }
  return value;
}

async function readLockSnapshot(file) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_OWNERSHIP_BYTES) throw new Error("runtime_lock_invalid");
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try { handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow); }
  catch { throw new Error("runtime_lock_invalid"); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_OWNERSHIP_BYTES) throw new Error("runtime_lock_changed");
    const rawBuffer = await handle.readFile();
    if (rawBuffer.length > MAX_OWNERSHIP_BYTES) throw new Error("runtime_lock_invalid");
    const raw = rawBuffer.toString("utf8");
    let current;
    try { current = validateLock(JSON.parse(raw)); }
    catch { throw new Error("runtime_lock_invalid"); }
    const after = await fsp.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after) || after.size !== opened.size) throw new Error("runtime_lock_changed");
    return { raw, current, stat: after };
  } finally {
    await handle.close();
  }
}

function validateLock(value) {
  exactObject(value, ["instanceId", "pid", "processStartIdentity", "packageVersion", "protocolVersion", "startedAt", "heartbeatAt"], "runtime_lock_invalid");
  if (typeof value.instanceId !== "string" || !/^run_[a-f0-9]{32}$/u.test(value.instanceId)) throw new Error("runtime_lock_invalid");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("runtime_lock_invalid");
  if (typeof value.processStartIdentity !== "string" || value.processStartIdentity.length < 1 || value.processStartIdentity.length > 256) throw new Error("runtime_lock_invalid");
  if (typeof value.packageVersion !== "string" || typeof value.protocolVersion !== "number" || value.protocolVersion !== 1) throw new Error("runtime_lock_invalid");
  if (!Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.heartbeatAt) || value.startedAt < 0 || value.heartbeatAt < value.startedAt) throw new Error("runtime_lock_invalid");
  return value;
}

const SELF_START_FALLBACK = "pid:" + process.pid + ":boot-ms:" + Math.floor(Date.now() - process.uptime() * 1000);

function processStartIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const close = text.lastIndexOf(")");
      const fields = text.slice(close + 2).split(" ");
      if (fields.length > 19 && /^[0-9]+$/u.test(fields[19])) return "linux:" + fields[19];
    } catch {}
  }
  return pid === process.pid ? SELF_START_FALLBACK : null;
}

export function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    if (error && error.code === "EPERM") return "inaccessible";
    return "inaccessible";
  }
}

export function probeProcessIdentity(pid, expectedIdentity) {
  const liveness = probeProcess(pid);
  if (liveness === "dead" || liveness === "inaccessible") return liveness;
  const actualIdentity = processStartIdentity(pid);
  if (actualIdentity === null) return "inaccessible";
  return actualIdentity === expectedIdentity ? "matching" : "mismatched";
}

export async function readRuntimeLock(layout) {
  try { return (await readLockSnapshot(layout.runtimeLock)).current; }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readHeartbeat(layout) {
  try {
    const value = await readPrivateJson(layout.heartbeatFile, "heartbeat_invalid");
    exactObject(value, ["instanceId", "state", "packageVersion", "schemaVersion", "generation", "observedAt"], "heartbeat_invalid");
    if (typeof value.instanceId !== "string" || !/^(?:run_[a-f0-9]{32}|none)$/u.test(value.instanceId)) throw new Error("heartbeat_invalid");
    if (!["STARTING", "RUNNING", "DEGRADED", "STOPPING", "STOPPED", "RECOVERY_REQUIRED"].includes(value.state)) throw new Error("heartbeat_invalid");
    if (typeof value.packageVersion !== "string" || !Number.isSafeInteger(value.schemaVersion) || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.observedAt)) throw new Error("heartbeat_invalid");
    return value;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicPrivateJson(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, ".runtime." + process.pid + "." + createId("run") + ".tmp");
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
  if (process.platform !== "win32") await fsp.chmod(file, 0o600);
}

export async function writeHeartbeat(layout, ownership, state, generation, now = Date.now()) {
  const record = {
    instanceId: ownership ? ownership.instanceId : "none",
    state,
    packageVersion: PRODUCT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generation,
    observedAt: now
  };
  if (ownership) {
    const current = await readRuntimeLock(layout);
    if (!sameOwner(current, ownership)) throw new Error("runtime_lock_lost");
  }
  await atomicPrivateJson(layout.heartbeatFile, record);
  if (ownership) ownership.heartbeatAt = now;
  return record;
}

async function createLock(layout, now) {
  const instanceId = createId("run");
  const record = {
    instanceId,
    pid: process.pid,
    processStartIdentity: processStartIdentity(process.pid),
    packageVersion: PRODUCT_VERSION,
    protocolVersion: 1,
    startedAt: now,
    heartbeatAt: now
  };
  const handle = await fsp.open(layout.runtimeLock, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await fsp.chmod(layout.runtimeLock, 0o600);
  return record;
}

export async function acquireRuntimeLock(layout, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const staleMs = options.staleMs === undefined ? DEFAULT_STALE_MS : options.staleMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(staleMs) || staleMs < 1) throw new Error("runtime_lock_options_invalid");
  try { return await createLock(layout, now); }
  catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }
  let before;
  try { before = await readLockSnapshot(layout.runtimeLock); }
  catch (error) {
    if (error && error.message === "runtime_lock_invalid") throw new Error("runtime_lock_uncertain");
    throw error;
  }
  const current = before.current;
  let identityState;
  if (typeof options.probeProcessIdentity === "function") identityState = options.probeProcessIdentity(current.pid, current.processStartIdentity);
  else if (typeof options.probeProcess === "function") {
    const legacy = options.probeProcess(current.pid);
    identityState = legacy === "alive" ? "matching" : legacy;
  } else identityState = probeProcessIdentity(current.pid, current.processStartIdentity);
  if (identityState === "matching") throw new Error("runtime_lock_busy");
  if (!["dead", "mismatched"].includes(identityState)) throw new Error("runtime_lock_uncertain");
  let lastHeartbeat = current.heartbeatAt;
  try {
    const heartbeat = await readHeartbeat(layout);
    if (heartbeat && heartbeat.instanceId === current.instanceId) lastHeartbeat = Math.max(lastHeartbeat, heartbeat.observedAt);
  } catch {
    throw new Error("runtime_lock_uncertain");
  }
  if (now - lastHeartbeat <= staleMs) throw new Error("runtime_lock_stale_unconfirmed");
  const after = await readLockSnapshot(layout.runtimeLock);
  if (after.raw !== before.raw || !sameFile(after.stat, before.stat)) throw new Error("runtime_lock_changed");
  await fsp.unlink(layout.runtimeLock);
  return await createLock(layout, now);
}

export async function releaseRuntimeLock(layout, ownership) {
  let before;
  try { before = await readLockSnapshot(layout.runtimeLock); }
  catch { return false; }
  if (!sameOwner(before.current, ownership)) return false;
  let after;
  try { after = await readLockSnapshot(layout.runtimeLock); }
  catch { return false; }
  if (after.raw !== before.raw || !sameFile(after.stat, before.stat) || !sameOwner(after.current, ownership)) return false;
  await fsp.unlink(layout.runtimeLock);
  return true;
}
