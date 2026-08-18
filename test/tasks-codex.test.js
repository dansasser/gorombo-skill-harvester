import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildCodexExecArgs, buildCodexProcessEnv, parseCodexEventLine, runCodexTask } from "../src/codex-process.js";
import { openStorage } from "../src/storage.js";
import { acceptTelegramTask, claimTask, claimTaskResult, completeTask, completeTaskResult, recoverUncertainTasks } from "../src/tasks.js";

const TEST_LAUNCH_PLAN = Object.freeze({
  command: "fixture-node",
  argsPrefix: Object.freeze(["fixture-codex.js"]),
  provenance: "packaged",
  source: "fixture-package",
  version: "0.147.0"
});

function binding(storage) {
  storage.upsertRoute("telegram", true, "READY", {}, 1);
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,state,approved_at) VALUES('bnd_0123456789abcdef0123456789abcdef','1','2','2','ACTIVE',1)").run();
  return "bnd_0123456789abcdef0123456789abcdef";
}

test("Codex arguments keep task text on stdin and strip it from argv", function () {
  const args = buildCodexExecArgs({ cwd: process.cwd(), sandbox: "read-only" });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--color", "never"]);
  assert.equal(args.at(-1), "-");
  assert.equal(args.includes("secret task text"), false);
  const resumed = buildCodexExecArgs({ cwd: process.cwd(), sandbox: "workspace-write", model: "gpt-fixture", threadId: "thread-one" });
  assert.ok(resumed.includes("resume"));
  assert.ok(resumed.includes("thread-one"));
  assert.deepEqual(resumed.slice(resumed.indexOf("--model"), resumed.indexOf("--model") + 2), ["--model", "gpt-fixture"]);
});

test("Codex JSONL parser captures private thread, final text, and completion", function () {
  const state = { threadId: null, lastMessage: null, errorText: null, turnCompleted: false };
  parseCodexEventLine('{"type":"thread.started","thread_id":"private"}', state);
  parseCodexEventLine('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}', state);
  parseCodexEventLine('{"type":"turn.completed"}', state);
  assert.deepEqual(state, { threadId: "private", lastMessage: "Done", errorText: null, turnCompleted: true });
});

test("Codex runner accepts a completed fake process", async function () {
  const spawn = function (executable, args, options) {
    assert.equal(executable, "fixture-node");
    assert.equal(args[0], "fixture-codex.js");
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = function () { child.killed = true; queueMicrotask(function () { child.emit("close", 1); }); };
    queueMicrotask(function () {
      child.stdout.write('{"type":"thread.started","thread_id":"private-thread"}\n');
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Task result"}}\n');
      child.stdout.write('{"type":"turn.completed"}\n');
      child.stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
  const result = await runCodexTask({ prompt: "Do the task", cwd: process.cwd(), sandbox: "read-only", launchPlan: TEST_LAUNCH_PLAN, spawn, timeoutMs: 1000 });
  assert.deepEqual(result, { ok: true, threadId: "private-thread", resultText: "Task result" });
});

test("Codex runner escalates cancellation and confirms process exit", async function () {
  const controller = new AbortController();
  const signals = [];
  const spawn = function () {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.pid = 12345;
    child.kill = function () { return true; };
    return child;
  };
  const pending = runCodexTask({
    prompt: "Wait until cancelled",
    cwd: process.cwd(),
    sandbox: "read-only",
    launchPlan: TEST_LAUNCH_PLAN,
    spawn,
    signal: controller.signal,
    timeoutMs: 1000,
    terminationGraceMs: 5,
    terminationConfirmMs: 50,
    terminateProcessTree: function (child, force) {
      signals.push(force ? "force" : "soft");
      if (force) queueMicrotask(function () { child.emit("close", 1); });
      return true;
    }
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  controller.abort();
  const result = await pending;
  assert.deepEqual(signals, ["soft", "force"]);
  assert.equal(result.category, "cancelled");
});

test("parent exit without confirmed tree termination stays recovery-safe", async function () {
  const controller = new AbortController();
  const signals = [];
  const spawn = function () {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.pid = 23456;
    child.kill = function () { return true; };
    return child;
  };
  const pending = runCodexTask({
    prompt: "Wait until cancelled",
    cwd: process.cwd(),
    sandbox: "read-only",
    launchPlan: TEST_LAUNCH_PLAN,
    spawn,
    signal: controller.signal,
    timeoutMs: 1000,
    terminationGraceMs: 5,
    terminationConfirmMs: 5,
    terminateProcessTree: function (child, force) {
      signals.push(force ? "force" : "soft");
      if (!force) queueMicrotask(function () { child.emit("close", 1); });
      return false;
    }
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  controller.abort();
  const result = await pending;
  assert.deepEqual(signals, ["soft", "force"]);
  assert.equal(result.category, "termination_unconfirmed");
});

test("Telegram task intake, completion, and durable result delivery are fenced", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const bindingId = binding(storage);
    const first = acceptTelegramTask(storage, { updateIdentity: "10", bindingId, text: "Inspect the project." }, 10);
    const duplicate = acceptTelegramTask(storage, { updateIdentity: "10", bindingId, text: "Inspect again." }, 11);
    assert.equal(first.status, "queued");
    assert.equal(duplicate.taskId, first.taskId);
    const claim = claimTask(storage, 12);
    const completed = completeTask(storage, claim, { ok: true, threadId: "private-thread", resultText: "Inspection complete." }, 13);
    assert.equal(completed.status, "succeeded");
    const delivery = claimTaskResult(storage, "result-worker", 14);
    assert.match(delivery.message, /Task complete/);
    const stale = { ...delivery, leaseToken: "run_" + "0".repeat(32) };
    assert.equal(completeTaskResult(storage, stale, { category: "accepted", providerReceiptRef: "7" }, 15).status, "stale");
    assert.throws(function () {
      completeTaskResult(storage, delivery, {
        category: "accepted",
        providerReceiptRef: "7",
        safeReceipt: { method: "sendMessage", messageDigest: "0".repeat(64) }
      }, 15);
    }, /task_result_delivery_invalid/);
    assert.equal(completeTaskResult(storage, delivery, {
      category: "accepted",
      providerReceiptRef: "7",
      safeReceipt: { method: "sendMessage", messageDigest: delivery.messageDigest }
    }, 15).status, "sent");
    assert.equal(storage.db.prepare("SELECT state FROM task_result_deliveries").get().state, "SENT");
  } finally {
    storage.close();
  }
});

test("approval-required tasks pause durably and do not execute again", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const bindingId = binding(storage);
    const accepted = acceptTelegramTask(storage, { updateIdentity: "11", bindingId, text: "Inspect the project." }, 10);
    const claim = claimTask(storage, 12);
    const safeResult = { ok: false, category: "approval_required", safeMessage: "The task requires host approval." };
    const completed = completeTask(storage, claim, safeResult, 13);
    assert.equal(completed.status, "waiting_approval");
    assert.ok(completed.deliveryId);
    const taskRow = storage.db.prepare("SELECT state,terminal_at FROM tasks WHERE id=?").get(accepted.taskId);
    assert.deepEqual({ ...taskRow }, { state: "WAITING_APPROVAL", terminal_at: null });
    const runRow = storage.db.prepare("SELECT state,completed_at,safe_result_json FROM task_runs WHERE task_id=?").get(accepted.taskId);
    assert.equal(runRow.state, "WAITING_APPROVAL");
    assert.equal(runRow.completed_at, 13);
    assert.deepEqual(JSON.parse(runRow.safe_result_json), safeResult);
    const delivery = storage.db.prepare(
      "SELECT task_id,state,message_private,message_digest FROM task_result_deliveries WHERE id=?"
    ).get(completed.deliveryId);
    assert.equal(delivery.task_id, accepted.taskId);
    assert.equal(delivery.state, "QUEUED");
    assert.match(delivery.message_private, /Task is waiting for host approval/);
    assert.match(delivery.message_private, new RegExp(accepted.taskId));
    assert.equal(delivery.message_digest, createHash("sha256").update(delivery.message_private, "utf8").digest("hex"));
    assert.equal(claimTask(storage, 14), null);
    assert.equal(recoverUncertainTasks(storage, 15), 0);
    assert.equal(storage.db.prepare("SELECT state FROM tasks WHERE id=?").get(accepted.taskId).state, "WAITING_APPROVAL");
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id=?").get(accepted.taskId).n, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM task_result_deliveries WHERE task_id=?").get(accepted.taskId).n, 1);
  } finally {
    storage.close();
  }
});

test("task results are safe and bounded for Telegram", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const bindingId = binding(storage);
    acceptTelegramTask(storage, { updateIdentity: "12", bindingId, text: "Inspect." }, 10);
    const claim = claimTask(storage, 11);
    const unsafe = completeTask(storage, claim, { ok: true, threadId: "private-thread", resultText: "Token: TELEGRAM_BOT_TOKEN=secret-value" }, 12);
    assert.equal(unsafe.status, "succeeded");
    const delivery = storage.db.prepare("SELECT message_private FROM task_result_deliveries WHERE id=?").get(unsafe.deliveryId);
    assert.match(delivery.message_private, /withheld from Telegram/);
    assert.doesNotMatch(delivery.message_private, /secret-value/);

    acceptTelegramTask(storage, { updateIdentity: "13", bindingId, text: "Inspect again." }, 13);
    const second = claimTask(storage, 14);
    const long = completeTask(storage, second, { ok: true, threadId: "private-thread", resultText: "x".repeat(20_000) }, 15);
    const longDelivery = storage.db.prepare("SELECT message_private FROM task_result_deliveries WHERE id=?").get(long.deliveryId);
    assert.ok(Array.from(longDelivery.message_private).length <= 4096);
    assert.match(longDelivery.message_private, /\[Result shortened\]/);
    assert.match(longDelivery.message_private, /Task ID:/);
  } finally {
    storage.close();
  }
});

test("expired task-result claims cannot commit", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const bindingId = binding(storage);
    acceptTelegramTask(storage, { updateIdentity: "14", bindingId, text: "Inspect." }, 10);
    const task = claimTask(storage, 11);
    completeTask(storage, task, { ok: true, threadId: "private-thread", resultText: "Done." }, 12);
    const delivery = claimTaskResult(storage, "result-worker", 13);
    assert.equal(completeTaskResult(storage, delivery, { category: "accepted", providerReceiptRef: "7" }, 90_013).status, "stale");
  } finally {
    storage.close();
  }
});

test("running tasks become recovery required after process loss", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const bindingId = binding(storage);
    acceptTelegramTask(storage, { updateIdentity: "11", bindingId, text: "Inspect." }, 10);
    claimTask(storage, 11);
    assert.equal(recoverUncertainTasks(storage, 12), 1);
    assert.equal(storage.db.prepare("SELECT state FROM tasks").get().state, "RECOVERY_REQUIRED");
  } finally {
    storage.close();
  }
});


test("Codex child environment is allowlisted and excludes Telegram and unrelated secrets", function () {
  const env = buildCodexProcessEnv({
    PATH: "runtime-path",
    USERPROFILE: "profile",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    UNRELATED_HOST_SECRET: "host-secret",
    CUSTOM_PROVIDER_KEY: "provider-secret"
  }, {
    OPENAI_API_KEY: "openai-secret",
    TELEGRAM_ALLOWED_USER_IDS: "123"
  }, ["CUSTOM_PROVIDER_KEY"]);
  assert.equal(env.PATH, "runtime-path");
  assert.equal(env.USERPROFILE, "profile");
  assert.equal(env.OPENAI_API_KEY, "openai-secret");
  assert.equal(env.CUSTOM_PROVIDER_KEY, "provider-secret");
  assert.equal(Object.hasOwn(env, "TELEGRAM_BOT_TOKEN"), false);
  assert.equal(Object.hasOwn(env, "TELEGRAM_ALLOWED_USER_IDS"), false);
  assert.equal(Object.hasOwn(env, "UNRELATED_HOST_SECRET"), false);
});
