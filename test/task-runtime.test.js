import assert from "node:assert/strict";
import test from "node:test";
import { revokeBinding } from "../src/pairing.js";
import { openStorage } from "../src/storage.js";
import { TaskResultDispatcher } from "../src/task-result-dispatcher.js";
import { TaskWorker } from "../src/task-worker.js";
import { acceptTelegramTask, claimTask, completeTask, markTaskClaimRecoveryRequired, recoverExpiredTaskResultLeases, taskClaimReady } from "../src/tasks.js";
import { TelegramSendGate } from "../src/telegram-send-gate.js";

const BINDING = "bnd_0123456789abcdef0123456789abcdef";

function setup(storage) {
  storage.upsertRoute("telegram", true, "READY", {}, 1);
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,state,approved_at) VALUES(?,?,?,?, 'ACTIVE',1)")
    .run(BINDING, "1", "2", "2");
}

function addTask(storage, updateIdentity, text, now) {
  return acceptTelegramTask(storage, { updateIdentity, bindingId: BINDING, text }, now);
}

async function eventually(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("eventually_timeout");
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
}

test("task worker runs queued tasks once, in order, and publishes only after durable completion", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "1", "First task", 10);
  addTask(storage, "2", "Second task", 11);
  const prompts = [];
  let active = 0;
  let maxActive = 0;
  let resultWakes = 0;
  const worker = new TaskWorker({
    storage,
    allowedUsers: new Set(["2"]),
    taskPolicy: { cwd: process.cwd(), sandbox: "read-only", timeoutMs: 1000 },
    runTask: async function (options) {
      prompts.push(options.prompt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(function (resolve) { setTimeout(resolve, 2); });
      active -= 1;
      return { ok: true, threadId: "private-thread", resultText: "Completed " + options.prompt };
    },
    onResultQueued: async function (completion) {
      const row = storage.db.prepare("SELECT state FROM task_result_deliveries WHERE id=?").get(completion.deliveryId);
      assert.equal(row.state, "QUEUED");
      resultWakes += 1;
    }
  });
  try {
    worker.start();
    await eventually(function () {
      return storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='SUCCEEDED'").get().count === 2;
    });
    assert.deepEqual(prompts, ["First task", "Second task"]);
    assert.equal(maxActive, 1);
    assert.equal(resultWakes, 2);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM task_result_deliveries").get().count, 2);
    assert.equal((await worker.stop()).status, "stopped");
  } finally {
    storage.close();
  }
});

test("running task cancellation aborts only the matching task and commits after runner exit", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  const accepted = addTask(storage, "3", "Wait for cancellation", 10);
  let observedAbort = false;
  const worker = new TaskWorker({
    storage,
    allowedUsers: new Set(["2"]),
    taskPolicy: { cwd: process.cwd(), sandbox: "read-only", timeoutMs: 1000 },
    runTask: async function (options) {
      return await new Promise(function (resolve) {
        options.signal.addEventListener("abort", function () {
          observedAbort = true;
          resolve({ ok: false, category: "cancelled", safeMessage: "The task was cancelled." });
        }, { once: true });
      });
    }
  });
  try {
    worker.start();
    await eventually(function () { return worker.status().activeTaskId === accepted.taskId; });
    assert.equal(worker.cancel("tsk_" + "0".repeat(32)), false);
    assert.equal(worker.cancel(accepted.taskId), true);
    await eventually(function () { return storage.db.prepare("SELECT state FROM tasks WHERE id=?").get(accepted.taskId).state === "CANCELLED"; });
    assert.equal(observedAbort, true);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM task_result_deliveries").get().count, 1);
    await worker.stop();
  } finally {
    storage.close();
  }
});

test("task worker rechecks the allowed user immediately before launch", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "4", "Do not launch after authorization changes", 10);
  let launches = 0;
  const worker = new TaskWorker({
    storage,
    allowedUsers: new Set(),
    taskPolicy: { cwd: process.cwd(), sandbox: "read-only", timeoutMs: 1000 },
    runTask: async function () {
      launches += 1;
      return { ok: true, resultText: "must not run" };
    }
  });
  try {
    worker.start();
    await eventually(function () { return storage.db.prepare("SELECT state FROM tasks").get().state === "RECOVERY_REQUIRED"; });
    assert.equal(launches, 0);
    assert.equal(storage.db.prepare("SELECT safe_result_json FROM task_runs").get().safe_result_json.includes("binding_or_user_inactive"), true);
    await worker.stop();
  } finally {
    storage.close();
  }
});

test("binding revocation before launch marks the exact task recovery required", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "4", "Do not launch", 10);
  try {
    const claim = claimTask(storage, 11);
    revokeBinding(storage, BINDING, 12);
    assert.equal(taskClaimReady(storage, claim), false);
    assert.equal(markTaskClaimRecoveryRequired(storage, claim, "binding_inactive", 13).status, "recovery_required");
    assert.equal(storage.db.prepare("SELECT state FROM tasks").get().state, "RECOVERY_REQUIRED");
    assert.equal(storage.db.prepare("SELECT state FROM task_runs").get().state, "RECOVERY_REQUIRED");
  } finally {
    storage.close();
  }
});

test("task worker stop grace fences an unresolved runner as recovery required", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "5", "Ignore cancellation", 10);
  const worker = new TaskWorker({
    storage,
    allowedUsers: new Set(["2"]),
    taskPolicy: { cwd: process.cwd(), sandbox: "read-only", timeoutMs: 1000 },
    runTask: async function () { return await new Promise(function () {}); },
    stopGraceMs: 10
  });
  try {
    worker.start();
    await eventually(function () { return worker.status().activeTaskId !== null; });
    assert.equal((await worker.stop()).status, "grace_expired");
    assert.equal(storage.db.prepare("SELECT state FROM tasks").get().state, "RECOVERY_REQUIRED");
  } finally {
    storage.close();
  }
});

test("task result dispatcher drains durable results with receipt-digest fencing", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "6", "Return a result", 10);
  const claim = claimTask(storage, 11);
  completeTask(storage, claim, { ok: true, threadId: "private-thread", resultText: "Durable result." }, 12);
  const sent = [];
  const dispatcher = new TaskResultDispatcher({
    storage,
    sender: {
      sendText: async function (chatIdentity, message) {
        sent.push({ chatIdentity, message });
        return { category: "accepted", providerReceiptRef: "44", safeReceipt: { method: "sendMessage" } };
      }
    },
    attemptTimeoutMs: 1000
  });
  try {
    dispatcher.start();
    await eventually(function () { return storage.db.prepare("SELECT state FROM task_result_deliveries").get().state === "SENT"; });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatIdentity, "2");
    assert.match(sent[0].message, /Durable result/);
    assert.equal((await dispatcher.stop()).status, "stopped");
  } finally {
    storage.close();
  }
});

test("expired task result sends become ambiguous retry work without rerunning the task", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  setup(storage);
  addTask(storage, "7", "Return a result", 10);
  const taskClaim = claimTask(storage, 11);
  completeTask(storage, taskClaim, { ok: true, threadId: "private-thread", resultText: "Stored once." }, 12);
  try {
    const row = storage.db.prepare("SELECT id FROM task_result_deliveries").get();
    storage.db.prepare("UPDATE task_result_deliveries SET state='SENDING',attempt_count=1,lease_token=?,lease_owner=?,lease_expires_at=? WHERE id=?")
      .run("run_" + "1".repeat(32), "worker", 20, row.id);
    assert.equal(recoverExpiredTaskResultLeases(storage, 20), 1);
    const recovered = storage.db.prepare("SELECT state,last_error_category,ambiguous_acceptance FROM task_result_deliveries").get();
    assert.equal(recovered.state, "RETRY_WAIT");
    assert.equal(recovered.last_error_category, "lease_expired");
    assert.equal(recovered.ambiguous_acceptance, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 1);
  } finally {
    storage.close();
  }
});

test("shared Telegram send gate serializes alerts, replies, and task results", async function () {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const gate = new TelegramSendGate({
    client: {
      sendText: async function () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return await new Promise(function (resolve) {
          releases.push(function (receipt) {
            active -= 1;
            resolve(receipt);
          });
        });
      }
    }
  });
  const accepted = function (id) {
    return { category: "accepted", providerReceiptRef: String(id), safeReceipt: { method: "sendMessage" } };
  };
  const first = gate.sendText("2", "reply");
  const second = gate.sendText("2", "task result");
  const alert = gate.alertAdapter(async function () { return { chatIdentity: "2" }; }).send({ plainText: "alert", renderedDigest: "a".repeat(64) });
  await eventually(function () { return releases.length === 1; });
  releases[0](accepted(1));
  await eventually(function () { return releases.length === 2; });
  releases[1](accepted(2));
  await eventually(function () { return releases.length === 3; });
  releases[2](accepted(3));
  const results = await Promise.all([first, second, alert]);
  assert.equal(maxActive, 1);
  assert.equal(results[2].safeReceipt.renderedDigest, "a".repeat(64));
  gate.close();
});
