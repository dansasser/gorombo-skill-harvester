import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendCompletionSpool, completionSpoolCount, drainCompletionSpool, watchCompletionSpool } from "../src/completion-spool.js";
import { createCompletionEvent } from "../src/harvester.js";
import { buildLayout, ensureOwnedLayout } from "../src/paths.js";
import { openStorage } from "../src/storage.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-spool-"));
  const codexRoot = path.join(root, ".codex");
  await fsp.mkdir(codexRoot);
  const layout = buildLayout(codexRoot);
  await ensureOwnedLayout(layout);
  const storage = openStorage(layout.databaseFile, { create: true, now: 1 });
  return { root, layout, storage };
}

function event(completedAt = 1000) {
  return createCompletionEvent({
    taskId: "session-spool",
    generation: 7,
    completedAt,
    sourceRevision: "spool-test-v1",
    evidence: [{ kind: "agent_result", text: "A reusable result completed." }]
  });
}

test("completion spool is durable, idempotent, and drains into authoritative storage", async function () {
  const x = await fixture();
  try {
    assert.equal((await appendCompletionSpool(x.layout, event())).status, "spooled_new");
    assert.equal((await appendCompletionSpool(x.layout, event())).status, "spooled_existing");
    assert.equal(await completionSpoolCount(x.layout), 1);
    const drained = await drainCompletionSpool(x.storage, x.layout, { now: 2000 });
    assert.equal(drained.processed, 1);
    assert.equal(drained.remaining, 0);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM completion_events").get().count, 1);
    assert.equal(await completionSpoolCount(x.layout), 0);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("same correlation with different immutable bytes cannot overwrite a spool record", async function () {
  const x = await fixture();
  try {
    await appendCompletionSpool(x.layout, event(1000));
    await assert.rejects(appendCompletionSpool(x.layout, event(1001)), /completion_spool_conflict/);
    assert.equal(await completionSpoolCount(x.layout), 1);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("malformed spool records fail closed and remain available for recovery", async function () {
  const x = await fixture();
  const file = path.join(x.layout.completionSpoolDir, "0".repeat(64) + ".json");
  try {
    await fsp.writeFile(file, "{}\n", { mode: 0o600 });
    await assert.rejects(drainCompletionSpool(x.storage, x.layout), /completion_spool_record_invalid/);
    assert.equal(await fsp.readFile(file, "utf8"), "{}\n");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM completion_events").get().count, 0);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("filesystem watch reports a newly published completion record", async function () {
  const x = await fixture();
  let resolveChange;
  const changed = new Promise(function (resolve) { resolveChange = resolve; });
  const watcher = await watchCompletionSpool(x.layout, function () { resolveChange(); });
  try {
    await appendCompletionSpool(x.layout, event());
    await Promise.race([
      changed,
      new Promise(function (_resolve, reject) { setTimeout(function () { reject(new Error("watch_timeout")); }, 2000); })
    ]);
  } finally {
    watcher.close();
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("redirected spool directories are rejected", async function (t) {
  const x = await fixture();
  const outside = path.join(x.root, "outside");
  try {
    x.storage.close();
    await fsp.rm(x.layout.completionSpoolDir, { recursive: true, force: true });
    await fsp.mkdir(outside, { mode: 0o700 });
    const sentinel = path.join(outside, "sentinel.txt");
    await fsp.writeFile(sentinel, "outside-must-not-change\n", "utf8");
    const beforeNames = await fsp.readdir(outside);
    const beforeBytes = await fsp.readFile(sentinel, "utf8");
    try {
      await fsp.symlink(outside, x.layout.completionSpoolDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && ["EPERM", "EACCES"].includes(error.code)) return t.skip("directory link creation unavailable");
      throw error;
    }
    await assert.rejects(appendCompletionSpool(x.layout, event()), /completion_spool_unsafe/);
    assert.deepEqual(await fsp.readdir(outside), beforeNames);
    assert.equal(await fsp.readFile(sentinel, "utf8"), beforeBytes);
  } finally {
    try { x.storage.close(); } catch {}
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});
