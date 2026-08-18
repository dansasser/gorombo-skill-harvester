import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { acceptCompletion, validateCompletionEvent } from "./harvester.js";
import { sha256, stableJson } from "./ids.js";
import { assertContained } from "./paths.js";

const RECORD_NAME = /^[a-f0-9]{64}\.json$/u;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_RECORDS = 4096;
const DEFAULT_DRAIN_LIMIT = 256;

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function assertPrivateDirectory(directory) {
  const info = await fsp.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("completion_spool_unsafe");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("completion_spool_permissions");
  const real = await fsp.realpath(directory);
  if (!samePath(real, directory)) throw new Error("completion_spool_unsafe");
  return real;
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function canonicalRecord(event) {
  const valid = validateCompletionEvent(event);
  const eventText = stableJson(valid);
  const record = { schemaVersion: 1, eventDigest: sha256(Buffer.from(eventText, "utf8")), event: valid };
  const text = stableJson(record) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new Error("completion_spool_record_too_large");
  return { event: valid, text, filename: valid.correlationKey + ".json" };
}

async function readExactFile(file) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_RECORD_BYTES) throw new Error("completion_spool_record_invalid");
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("completion_spool_record_permissions");
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size !== before.size) throw new Error("completion_spool_record_changed");
    const buffer = await handle.readFile();
    if (buffer.length !== opened.size || buffer.length > MAX_RECORD_BYTES) throw new Error("completion_spool_record_invalid");
    const after = await fsp.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after) || after.size !== opened.size) throw new Error("completion_spool_record_changed");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function decodeRecord(raw, filename) {
  let record;
  try { record = JSON.parse(raw); }
  catch { throw new Error("completion_spool_record_invalid"); }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["event", "eventDigest", "schemaVersion"].sort()) ||
      record.schemaVersion !== 1 || typeof record.eventDigest !== "string") {
    throw new Error("completion_spool_record_invalid");
  }
  const event = validateCompletionEvent(record.event);
  const eventDigest = sha256(Buffer.from(stableJson(event), "utf8"));
  if (eventDigest !== record.eventDigest || filename !== event.correlationKey + ".json" || stableJson(record) + "\n" !== raw) {
    throw new Error("completion_spool_record_invalid");
  }
  return { event, raw };
}

async function finalRecordNames(directory) {
  await assertPrivateDirectory(directory);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_RECORDS * 2) throw new Error("completion_spool_backlog_exceeded");
  const names = [];
  for (const entry of entries) {
    if (entry.isFile() && RECORD_NAME.test(entry.name)) names.push(entry.name);
    else if (entry.isFile() && /^\.completion\.[a-f0-9.]+\.tmp$/u.test(entry.name)) continue;
    else throw new Error("completion_spool_record_invalid");
  }
  names.sort();
  if (names.length > MAX_RECORDS) throw new Error("completion_spool_backlog_exceeded");
  return names;
}

export async function appendCompletionSpool(layout, event) {
  const record = canonicalRecord(event);
  const directory = await assertPrivateDirectory(layout.completionSpoolDir);
  const finalFile = assertContained(directory, path.join(directory, record.filename));
  try {
    const existing = await readExactFile(finalFile);
    if (existing !== record.text) throw new Error("completion_spool_conflict");
    return { status: "spooled_existing", correlationKey: record.event.correlationKey };
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      if (error && error.message === "completion_spool_conflict") throw error;
      try {
        const existing = await readExactFile(finalFile);
        if (existing === record.text) return { status: "spooled_existing", correlationKey: record.event.correlationKey };
      } catch {}
      if (!error || error.code !== "ENOENT") throw error;
    }
  }

  const temporary = assertContained(directory, path.join(directory,
    ".completion." + record.event.correlationKey + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp"));
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(record.text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.link(temporary, finalFile);
    await syncDirectory(directory);
    return { status: "spooled_new", correlationKey: record.event.correlationKey };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const existing = await readExactFile(finalFile);
    if (existing !== record.text) throw new Error("completion_spool_conflict");
    return { status: "spooled_existing", correlationKey: record.event.correlationKey };
  } finally {
    try { await fsp.unlink(temporary); } catch {}
  }
}

export async function removeCompletionSpool(layout, event) {
  const record = canonicalRecord(event);
  const directory = await assertPrivateDirectory(layout.completionSpoolDir);
  const finalFile = assertContained(directory, path.join(directory, record.filename));
  try {
    const current = await readExactFile(finalFile);
    if (current !== record.text) throw new Error("completion_spool_conflict");
    await fsp.unlink(finalFile);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function drainCompletionSpool(storage, layout, options = {}) {
  const limit = options.limit === undefined ? DEFAULT_DRAIN_LIMIT : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_DRAIN_LIMIT) throw new Error("completion_spool_limit_invalid");
  const directory = await assertPrivateDirectory(layout.completionSpoolDir);
  const names = await finalRecordNames(directory);
  let processed = 0;
  const results = [];
  for (const name of names.slice(0, limit)) {
    const file = assertContained(directory, path.join(directory, name));
    const decoded = decodeRecord(await readExactFile(file), name);
    const result = acceptCompletion(storage, decoded.event, options.now === undefined ? Date.now() : options.now);
    const current = await readExactFile(file);
    if (current !== decoded.raw) throw new Error("completion_spool_record_changed");
    await fsp.unlink(file);
    await syncDirectory(directory);
    processed += 1;
    results.push(result.status);
  }
  return { processed, remaining: Math.max(0, names.length - processed), results };
}

export async function completionSpoolCount(layout) {
  return (await finalRecordNames(layout.completionSpoolDir)).length;
}

export async function watchCompletionSpool(layout, onChange, onError = function () {}, options = {}) {
  if (typeof onChange !== "function" || typeof onError !== "function") throw new Error("completion_spool_watch_invalid");
  const directory = await assertPrivateDirectory(layout.completionSpoolDir);
  const watch = options.watch || fs.watch;
  let closed = false;
  const watcher = watch(directory, { persistent: true }, function () {
    if (closed) return;
    try {
      const result = onChange();
      if (result && typeof result.catch === "function") result.catch(function () { onError(new Error("completion_spool_drain_failed")); });
    } catch {
      onError(new Error("completion_spool_drain_failed"));
    }
  });
  watcher.on("error", function () {
    if (!closed) onError(new Error("completion_spool_watch_failed"));
  });
  return {
    close: function () {
      if (closed) return;
      closed = true;
      watcher.close();
    }
  };
}
