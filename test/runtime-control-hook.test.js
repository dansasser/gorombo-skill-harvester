import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completionEventFromHook, submitCompletionEvent } from "../src/completion-hook.js";
import { CONTROL_PROTOCOL_VERSION, ControlServer, sendControlCommand } from "../src/control.js";
import { buildLayout, ensureOwnedLayout } from "../src/paths.js";
import { acquireRuntimeLock, probeProcessIdentity, readHeartbeat, releaseRuntimeLock, writeHeartbeat } from "../src/runtime-lock.js";
import { openStorage } from "../src/storage.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-runtime-"));
  const codexRoot = path.join(root, "codex");
  await fsp.mkdir(codexRoot);
  const layout = buildLayout(codexRoot);
  await ensureOwnedLayout(layout);
  return { root, codexRoot, layout };
}

function testEndpoint(layout, label) {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\gorombo-skill-harvester-test-" + label + "-" + process.pid + "-" + Date.now()
    : path.join(layout.runtimeDir, label + ".sock");
}

test("runtime ownership, heartbeat, and process-identity recovery are fenced", async function () {
  const x = await fixture();
  try {
    const ownership = await acquireRuntimeLock(x.layout, { now: 1000 });
    assert.equal(probeProcessIdentity(process.pid, ownership.processStartIdentity), "matching");
    await assert.rejects(acquireRuntimeLock(x.layout, { now: 1001 }), /runtime_lock_busy/);
    await writeHeartbeat(x.layout, ownership, "RUNNING", 1, 1010);
    const heartbeat = await readHeartbeat(x.layout);
    assert.equal(heartbeat.instanceId, ownership.instanceId);
    assert.equal(heartbeat.state, "RUNNING");
    await assert.rejects(
      acquireRuntimeLock(x.layout, { now: 2000, staleMs: 100, probeProcessIdentity: function () { return "inaccessible"; } }),
      /runtime_lock_uncertain/
    );
    const replacement = await acquireRuntimeLock(x.layout, {
      now: 2000,
      staleMs: 100,
      probeProcessIdentity: function () { return "mismatched"; }
    });
    assert.notEqual(replacement.instanceId, ownership.instanceId);
    assert.equal(await releaseRuntimeLock(x.layout, ownership), false);
    assert.equal(await releaseRuntimeLock(x.layout, replacement), true);
  } finally {
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("private control endpoint requires runtime ownership and carries one bounded command", async function () {
  const x = await fixture();
  const endpoint = testEndpoint(x.layout, "control");
  const ownership = await acquireRuntimeLock(x.layout);
  const server = new ControlServer(x.layout, async function (command, payload) {
    assert.equal(command, "status");
    return { echo: payload.value };
  }, { endpoint, ownership });
  try {
    await server.start();
    const result = await sendControlCommand(x.layout, "status", { value: "safe" }, { endpoint });
    assert.deepEqual(result, { echo: "safe" });
  } finally {
    await server.close();
    await releaseRuntimeLock(x.layout, ownership);
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("control startup rejects a regular file instead of unlinking it", async function () {
  const x = await fixture();
  const endpoint = path.join(x.layout.runtimeDir, "not-a-socket");
  const ownership = await acquireRuntimeLock(x.layout);
  await fsp.writeFile(endpoint, "preserve");
  const server = new ControlServer(x.layout, async function () {}, { endpoint, ownership, platform: "linux" });
  try {
    await assert.rejects(server.start(), /control_endpoint_unsafe/);
    assert.equal(await fsp.readFile(endpoint, "utf8"), "preserve");
  } finally {
    await server.close();
    await releaseRuntimeLock(x.layout, ownership);
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("control client rejects a response for a different request", async function () {
  const x = await fixture();
  const endpoint = testEndpoint(x.layout, "mismatch");
  const server = net.createServer(function (socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", function (chunk) {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.end(JSON.stringify({
        version: CONTROL_PROTOCOL_VERSION,
        requestId: "run_" + "0".repeat(32),
        ok: true,
        result: {}
      }) + "\n");
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    await assert.rejects(sendControlCommand(x.layout, "status", {}, { endpoint }), /control_response_invalid/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("completion hook accepts documented update_goal completion and ignores transcript paths", async function () {
  const x = await fixture();
  try {
    const transcript = path.join(x.root, "transcript.jsonl");
    await fsp.writeFile(transcript, JSON.stringify({ payload: { type: "message", role: "user", content: [{ text: "DO NOT READ THIS FILE" }] } }) + "\n");
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "functions.update_goal",
      tool_use_id: "tool-call-1",
      turn_id: "turn-safe",
      session_id: "session-safe",
      tool_input: { status: "complete" },
      tool_response: { status: "complete", summary: "Built and verified the reusable checklist." },
      goal_objective: "Create a repeatable release checklist.",
      transcript_path: transcript,
      completed_at: 1000
    };
    const event = await completionEventFromHook(input);
    assert.equal(event.terminalStatus, "complete");
    assert.deepEqual(event.evidence.map(function (item) { return item.kind; }), ["user_request", "agent_result"]);
    assert.equal(event.evidence[0].text, "Create a repeatable release checklist.");
    assert.equal(event.evidence[1].text, "Built and verified the reusable checklist.");
    assert.doesNotMatch(JSON.stringify(event), /DO NOT READ/);
    assert.equal(await completionEventFromHook({ ...input, tool_input: { status: "blocked" } }), null);
    const generic = await completionEventFromHook({
      hook_event_name: "PostToolUse",
      tool_name: "update_goal",
      tool_use_id: "tool-call-2",
      turn_id: "turn-generic",
      session_id: "session-generic",
      tool_input: { status: "complete" },
      tool_response: {}
    });
    assert.match(generic.evidence[0].text, /goal completed successfully/);
    await assert.rejects(
      completionEventFromHook({ ...input, session_id: undefined, thread_id: "unproven-fallback" }),
      /completion_task_id_invalid/
    );
  } finally {
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("completion hook commits offline only while holding temporary runtime ownership", async function () {
  const x = await fixture();
  const storage = openStorage(x.layout.databaseFile, { create: true, now: 1000 });
  storage.close();
  try {
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "update_goal",
      tool_use_id: "tool-call-offline",
      session_id: "session-offline",
      tool_input: { status: "complete" },
      tool_response: {},
      goal_objective: "Turn this repeatable work into a safe skill recommendation.",
      completed_at: 1000
    };
    const event = await completionEventFromHook(input);
    const result = await submitCompletionEvent(event, {
      codexRoot: x.codexRoot,
      sendControl: async function () { throw new Error("runtime_unavailable"); }
    });
    assert.equal(result.status, "accepted_new");
    const verify = openStorage(x.layout.databaseFile, { create: false });
    try { assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM completion_events").get().count, 1); }
    finally { verify.close(); }
    await assert.rejects(fsp.lstat(x.layout.runtimeLock), function (error) { return error && error.code === "ENOENT"; });
  } finally {
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("completion hook durably spools while a runtime owns storage", async function () {
  const x = await fixture();
  const storage = openStorage(x.layout.databaseFile, { create: true, now: 1000 });
  storage.close();
  const ownership = await acquireRuntimeLock(x.layout);
  try {
    const event = await completionEventFromHook({
      hook_event_name: "PostToolUse",
      tool_name: "update_goal",
      tool_use_id: "tool-call-race",
      session_id: "session-race",
      tool_input: { status: "complete" },
      tool_response: {}
    });
    const result = await submitCompletionEvent(event, {
      codexRoot: x.codexRoot,
      sendControl: async function () { throw new Error("runtime_unavailable"); }
    });
    assert.equal(result.status, "spooled_new");
    const verify = openStorage(x.layout.databaseFile, { create: false });
    try { assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM completion_events").get().count, 0); }
    finally { verify.close(); }
    const records = (await fsp.readdir(x.layout.completionSpoolDir)).filter(function (name) { return name.endsWith(".json"); });
    assert.deepEqual(records, [event.correlationKey + ".json"]);
  } finally {
    await releaseRuntimeLock(x.layout, ownership);
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("runtime lock recovery rejects file symlinks", async function (t) {
  const x = await fixture();
  try {
    const target = path.join(x.layout.runtimeDir, "lock-target.json");
    await fsp.writeFile(target, "{}\n");
    try {
      await fsp.symlink(target, x.layout.runtimeLock, "file");
    } catch (error) {
      if (error && ["EPERM", "EACCES"].includes(error.code)) return t.skip("file symlink creation unavailable");
      throw error;
    }
    await assert.rejects(
      acquireRuntimeLock(x.layout, { now: 1000, staleMs: 1, probeProcessIdentity: function () { return "dead"; } }),
      /runtime_lock_uncertain/
    );
    assert.equal(await fsp.readFile(target, "utf8"), "{}\n");
  } finally {
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("runtime lock release checks the full owner identity", async function () {
  const x = await fixture();
  try {
    const ownership = await acquireRuntimeLock(x.layout);
    assert.equal(await releaseRuntimeLock(x.layout, { ...ownership, pid: ownership.pid + 1 }), false);
    assert.notEqual(await fsp.lstat(x.layout.runtimeLock), null);
    assert.equal(await releaseRuntimeLock(x.layout, ownership), true);
  } finally {
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});
