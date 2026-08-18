import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { completionEventFromHook, submitCompletionEvent } from "../src/completion-hook.js";
import { sendControlCommand } from "../src/control.js";
import { isCliEntry, runCli } from "../src/cli.js";
import { onboard } from "../src/onboarding.js";
import { buildLayout } from "../src/paths.js";
import { inspectReadiness } from "../src/readiness.js";
import { recoverRuntime } from "../src/recovery.js";
import { acquireRuntimeLock, readHeartbeat, readRuntimeLock, releaseRuntimeLock, writeHeartbeat } from "../src/runtime-lock.js";
import { startRuntime } from "../src/runtime.js";
import { openStorage } from "../src/storage.js";

const TEST_LAUNCH_PLAN = Object.freeze({
  command: "fixture-node",
  argsPrefix: Object.freeze(["fixture-codex.js"]),
  provenance: "packaged",
  source: "fixture-package",
  version: "0.147.0"
});

async function preflightOk() {
  return { ok: true, nodeVersion: "fixture" };
}

test("CLI main detection follows a package-manager symlink", function () {
  const entry = path.resolve("fixture-bin", "gorombo-skill-harvester");
  const moduleFile = path.resolve("fixture-package", "src", "cli.js");
  const resolveRealPath = function (value) {
    if (value === entry) return moduleFile;
    return value;
  };
  assert.equal(isCliEntry(entry, moduleFile, resolveRealPath), true);
  assert.equal(isCliEntry(path.resolve("somewhere-else"), moduleFile, resolveRealPath), false);
});

async function eventually(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("eventually_timeout");
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
  }
}

async function temporaryCodexRoot() {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-runtime-"));
  const root = path.join(parent, ".codex");
  await fsp.mkdir(root);
  return { parent, root };
}

function telegramUpdate(id, text) {
  return {
    update_id: id,
    message: {
      from: { id: 200 },
      chat: { id: 200, type: "private" },
      text
    }
  };
}

class FakeTelegramClient {
  constructor() {
    this.batches = [];
    this.waiters = [];
    this.sent = [];
    this.nextReceipt = 1;
    this.failUpdates = false;
  }

  async getIdentity() {
    return { botIdentity: "100", username: "gorombo_skill_harvester_fixture" };
  }

  push(update) {
    const batch = [update];
    const waiter = this.waiters.shift();
    if (waiter) waiter.finish(batch);
    else this.batches.push(batch);
  }

  async getUpdates(_offset, signal) {
    if (this.failUpdates) throw new Error("seeded-private-provider-error");
    if (this.batches.length > 0) return this.batches.shift();
    return await new Promise((resolve) => {
      const entry = {
        finish: (value) => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          if (signal) signal.removeEventListener("abort", entry.abort);
          resolve(value);
        },
        abort: null
      };
      entry.abort = function () { entry.finish([]); };
      if (signal && signal.aborted) return entry.abort();
      if (signal) signal.addEventListener("abort", entry.abort, { once: true });
      this.waiters.push(entry);
    });
  }

  async sendText(chatIdentity, message) {
    this.sent.push({ chatIdentity, message });
    return {
      category: "accepted",
      providerReceiptRef: String(this.nextReceipt++),
      safeReceipt: { method: "sendMessage" }
    };
  }
}

class FakeAppServerClient {
  constructor() {
    this.started = false;
    this.closed = false;
    this.turns = [];
    this.thread = { id: "thread-private-fixture", name: "Harvester Inbox", status: "idle" };
  }

  async start() {
    this.started = true;
    return this;
  }

  async request(method, params) {
    if (method === "thread/list") return { data: [this.thread], nextCursor: null };
    if (method === "turn/start") {
      assert.equal(params.threadId, this.thread.id);
      this.turns.push(params.input[0].text);
      return { turn: { id: "turn-private-fixture", threadId: this.thread.id } };
    }
    if (method === "thread/start") return { thread: this.thread };
    if (method === "thread/name/set") {
      this.thread = { ...this.thread, name: params.name };
      return {};
    }
    throw new Error("unexpected_app_server_method");
  }

  async waitForNotification(predicate) {
    const value = {
      method: "turn/completed",
      params: {
        threadId: this.thread.id,
        turn: { id: "turn-private-fixture", status: "completed" }
      }
    };
    if (!predicate(value)) throw new Error("notification_mismatch");
    return value;
  }

  async close() {
    this.closed = true;
  }
}

test("unonboarded runtime and CLI status stay read-only", async function () {
  const temporary = await temporaryCodexRoot();
  try {
    const layout = buildLayout(temporary.root);
    await assert.rejects(startRuntime({ codexRoot: temporary.root, runPreflight: preflightOk }), /codex_launch_plan_missing/);
    await assert.rejects(startRuntime({
      codexRoot: temporary.root,
      runPreflight: async function () { return { launchPlan: TEST_LAUNCH_PLAN }; }
    }), /onboarding_required/);
    await assert.rejects(fsp.lstat(layout.productRoot), function (error) { return error && error.code === "ENOENT"; });

    const output = [];
    const errors = [];
    const exit = await runCli(["status", "--json"], {
      codexRoot: temporary.root,
      stdout: { write: function (value) { output.push(value); } },
      stderr: { write: function (value) { errors.push(value); } }
    });
    assert.equal(exit, 2);
    assert.equal(errors.length, 0);
    assert.equal(JSON.parse(output.join("")).status, "NEEDS_ONBOARDING");
    await assert.rejects(fsp.lstat(layout.productRoot), function (error) { return error && error.code === "ENOENT"; });
  } finally {
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("both-mode runtime pairs Telegram, verifies both routes, runs tasks, and shuts down cleanly", async function () {
  const temporary = await temporaryCodexRoot();
  const taskDirectory = path.join(temporary.parent, "work");
  await fsp.mkdir(taskDirectory);
  const layout = buildLayout(temporary.root);
  const telegram = new FakeTelegramClient();
  const appServer = new FakeAppServerClient();
  let runtime = null;
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "both", runPreflight: preflightOk });
    await fsp.writeFile(layout.environmentFile, [
      "TELEGRAM_BOT_TOKEN=test-token-placeholder",
      "TELEGRAM_ALLOWED_USER_IDS=200",
      "GOROMBO_SKILL_HARVESTER_TASK_CWD=" + taskDirectory,
      "GOROMBO_SKILL_HARVESTER_TASK_SANDBOX=read-only",
      ""
    ].join("\n"), { mode: 0o600 });
    await onboard({ codexRoot: temporary.root, routeMode: "both", runPreflight: preflightOk });

    telegram.push(telegramUpdate(1, "/start"));
    runtime = await startRuntime({
      codexRoot: temporary.root,
      runPreflight: async function () { return { launchPlan: TEST_LAUNCH_PLAN }; },
      env: { ...process.env, CODEX_HOME: temporary.root, TELEGRAM_BOT_TOKEN: "host-telegram-secret" },
      telegramClient: telegram,
      appServerClient: appServer,
      heartbeatIntervalMs: 1000,
      runTask: async function (options) {
        assert.equal(options.launchPlan, TEST_LAUNCH_PLAN);
        assert.equal(options.env.CODEX_HOME, temporary.root);
        assert.equal(Object.hasOwn(options.env, "TELEGRAM_BOT_TOKEN"), false);
        if (options.prompt === "Wait until cancelled.") {
          return await new Promise((resolve) => {
            const finish = function () {
              resolve({ ok: false, category: "cancelled", safeMessage: "The task was cancelled." });
            };
            if (options.signal.aborted) finish();
            else options.signal.addEventListener("abort", finish, { once: true });
          });
        }
        return { ok: true, resultText: "The requested inspection completed." };
      }
    });

    const completion = await completionEventFromHook({
      hook_event_name: "PostToolUse",
      tool_name: "update_goal",
      tool_use_id: "runtime-spool-live",
      session_id: "runtime-spool-session",
      tool_input: { status: "complete" },
      tool_response: { summary: "A live completion reached the durable inbox." },
      completed_at: 1000
    });
    const handoff = await submitCompletionEvent(completion, {
      codexRoot: temporary.root,
      sendControl: async function () { throw new Error("simulated_control_outage"); }
    });
    assert.match(handoff.status, /^spooled_/u);
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM completion_events WHERE correlation_key=?").get(completion.correlationKey).count === 1;
    });
    await eventually(async function () { return (await fsp.readdir(layout.completionSpoolDir)).filter(function (name) { return name.endsWith(".json"); }).length === 0; });

    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE state='PENDING'").get().count === 1;
    });
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_reply_deliveries WHERE purpose='PAIRING' AND state='SENT'").get().count === 1;
    });
    const pairing = runtime.storage.db.prepare("SELECT message_private FROM telegram_reply_deliveries WHERE purpose='PAIRING'").get();
    const code = pairing.message_private.match(/pairing code: ([0-9A-F]{6})/u)[1];

    assert.deepEqual(await sendControlCommand(layout, "pair.approve", { code }), { status: "approved" });
    assert.deepEqual(await sendControlCommand(layout, "route.test", { route: "telegram" }), {
      status: "queued",
      route: "telegram"
    });
    await eventually(function () { return runtime.storage.getRoute("telegram").state === "READY"; });

    assert.deepEqual(await sendControlCommand(layout, "external-alert.enqueue", {
      key: "harvester.propose-new:external-runtime-test",
      message: "Gorombo Skill Harvester recommends a new skill\n\nRecommended skill: runtime-test"
    }), { result: "queued" });
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM external_alert_deliveries WHERE state='SENT'").get().count === 1;
    });
    assert.deepEqual(await sendControlCommand(layout, "external-alert.enqueue", {
      key: "harvester.propose-new:external-runtime-test",
      message: "Gorombo Skill Harvester recommends a new skill\n\nRecommended skill: runtime-test"
    }), { result: "existing" });

    const listed = await sendControlCommand(layout, "session.list", {});
    assert.deepEqual(listed, { sessions: [{ name: "Harvester Inbox", status: "idle" }] });
    const selected = await sendControlCommand(layout, "session.select", { name: "Harvester Inbox" });
    assert.deepEqual(selected, { status: "selected", name: "Harvester Inbox" });
    const sessionTest = await sendControlCommand(layout, "route.test", { route: "session" });
    assert.equal(sessionTest.status, "accepted");
    await eventually(function () { return runtime.storage.getRoute("session").state === "READY"; });
    assert.match(appServer.turns[0], /Codex session delivery test/);

    telegram.push(telegramUpdate(2, "Inspect the project."));
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='SUCCEEDED'").get().count === 1;
    });
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM task_result_deliveries WHERE state='SENT'").get().count === 1;
    });

    telegram.push(telegramUpdate(3, "Wait until cancelled."));
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RUNNING'").get().count === 1;
    });
    const running = runtime.storage.db.prepare("SELECT id FROM tasks WHERE state='RUNNING'").get();
    assert.deepEqual(await sendControlCommand(layout, "task.cancel", { taskId: running.id }), { status: "aborting" });
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT state FROM tasks WHERE id=?").get(running.id).state === "CANCELLED";
    });

    const status = await sendControlCommand(layout, "status", {});
    assert.equal(status.status, "RUNNING");
    assert.equal(status.routes.telegram.state, "READY");
    assert.equal(status.routes.session.state, "READY");
    assert.equal(status.runtime.telegram.running, true);
    assert.equal(status.runtime.session.running, true);
    telegram.failUpdates = true;
    telegram.push(telegramUpdate(4, "/status"));
    await eventually(function () {
      const current = runtime.status();
      return current.status === "DEGRADED" && current.runtime.telegram.errorCode === "telegram_updates_failed";
    });
    telegram.failUpdates = false;
    telegram.push(telegramUpdate(5, "/help"));
    await eventually(function () { return runtime.status().runtime.telegram.errorCode === null; }, 3000);
    assert.equal(runtime.status().status, "RUNNING");
    const serialized = JSON.stringify(status);
    for (const privateValue of ["test-token-placeholder", "host-telegram-secret", "Inspect the project.", "thread-private-fixture", taskDirectory]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    assert.ok(telegram.sent.some(function (item) { return item.message.includes("Telegram delivery test"); }));
    assert.ok(telegram.sent.some(function (item) { return item.message.includes("Task complete"); }));
    assert.ok(telegram.sent.some(function (item) { return item.message.startsWith("Source: External Harvester\n\nGorombo Skill Harvester recommends"); }));

    const stopped = await runtime.stop();
    assert.deepEqual(stopped, { status: "stopped" });
    assert.equal(await readRuntimeLock(layout), null);
    assert.equal((await readHeartbeat(layout)).state, "STOPPED");
    assert.equal(appServer.closed, true);
  } finally {
    if (runtime) {
      try { await runtime.stop(); } catch {}
    }
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("CLI maps safe live commands and rejects invalid arguments without secrets", async function () {
  const temporary = await temporaryCodexRoot();
  const stdout = [];
  const stderr = [];
  const calls = [];
  try {
    const common = {
      codexRoot: temporary.root,
      cwd: function () { return temporary.parent; },
      stdout: { write: function (value) { stdout.push(value); } },
      stderr: { write: function (value) { stderr.push(value); } },
      sendControlCommand: async function (_layout, command, payload) {
        calls.push({ command, payload });
        return { status: "ok" };
      }
    };
    assert.equal(await runCli(["session", "create", "Harvester Inbox"], common), 0);
    assert.equal(calls[0].command, "session.create");
    assert.equal(calls[0].payload.name, "Harvester Inbox");
    assert.equal(calls[0].payload.workingDirectory, path.resolve(temporary.parent));

    common.stdin = Readable.from([Buffer.from("Readable recommendation alert", "utf8")]);
    common.sendControlCommand = async function (_layout, command, payload) {
      calls.push({ command, payload });
      return command === "external-alert.enqueue" ? { result: "queued" } : { status: "ok" };
    };
    assert.equal(await runCli(["alert", "ingest", "--key", "harvester.propose-new:cli-test"], common), 0);
    assert.deepEqual(JSON.parse(stdout[stdout.length - 1]), { result: "queued" });
    assert.equal(calls[calls.length - 1].command, "external-alert.enqueue");
    assert.deepEqual(calls[calls.length - 1].payload, {
      key: "harvester.propose-new:cli-test",
      message: "Readable recommendation alert"
    });

    assert.equal(await runCli(["pair", "not-a-code"], common), 64);
    const failure = JSON.parse(stderr[stderr.length - 1]);
    assert.equal(failure.error.code, "pairing_code_invalid");
    assert.equal(JSON.stringify(failure).includes("test-token-placeholder"), false);

    const readiness = await inspectReadiness({ codexRoot: temporary.root });
    assert.equal(readiness.status, "NEEDS_ONBOARDING");
  } finally {
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("runtime retains ownership when an active task exceeds shutdown grace", async function () {
  const temporary = await temporaryCodexRoot();
  const taskDirectory = path.join(temporary.parent, "work");
  await fsp.mkdir(taskDirectory);
  const layout = buildLayout(temporary.root);
  const telegram = new FakeTelegramClient();
  let runtime = null;
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "telegram", runPreflight: preflightOk });
    await fsp.writeFile(layout.environmentFile, [
      "TELEGRAM_BOT_TOKEN=test-token-placeholder",
      "TELEGRAM_ALLOWED_USER_IDS=200",
      "GOROMBO_SKILL_HARVESTER_TASK_CWD=" + taskDirectory,
      "GOROMBO_SKILL_HARVESTER_TASK_SANDBOX=read-only",
      ""
    ].join("\n"), { mode: 0o600 });
    await onboard({ codexRoot: temporary.root, routeMode: "telegram", runPreflight: preflightOk });
    telegram.push(telegramUpdate(1, "/start"));
    runtime = await startRuntime({
      codexRoot: temporary.root,
      runPreflight: preflightOk,
      codexLaunchPlan: TEST_LAUNCH_PLAN,
      telegramClient: telegram,
      stopGraceMs: 20,
      runTask: async function () { return await new Promise(function () {}); }
    });
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE state='PENDING'").get().count === 1;
    });
    const pairing = runtime.storage.db.prepare("SELECT message_private FROM telegram_reply_deliveries WHERE purpose='PAIRING'").get();
    const code = pairing.message_private.match(/pairing code: ([0-9A-F]{6})/u)[1];
    await runtime.handleControl("pair.approve", { code });
    await runtime.handleControl("route.test", { route: "telegram" });
    await eventually(function () { return runtime.storage.getRoute("telegram").state === "READY"; });
    telegram.push(telegramUpdate(2, "Hang forever."));
    await eventually(function () {
      return runtime.storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RUNNING'").get().count === 1;
    });
    assert.deepEqual(await runtime.stop(), { status: "recovery_required" });
    const lock = await readRuntimeLock(layout);
    assert.equal(lock.instanceId, runtime.ownership.instanceId);
    assert.equal((await readHeartbeat(layout)).state, "RECOVERY_REQUIRED");
  } finally {
    if (runtime) {
      try { runtime.storage.close(); } catch {}
      try { await releaseRuntimeLock(layout, runtime.ownership); } catch {}
    }
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("recovery heartbeat blocks transport startup until local recovery", async function () {
  const temporary = await temporaryCodexRoot();
  const layout = buildLayout(temporary.root);
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "session", runPreflight: preflightOk });
    const ownership = await acquireRuntimeLock(layout, { now: Date.now() });
    await writeHeartbeat(layout, ownership, "RECOVERY_REQUIRED", 1, Date.now());
    assert.equal(await releaseRuntimeLock(layout, ownership), true);
    await assert.rejects(startRuntime({ codexRoot: temporary.root, runPreflight: preflightOk, codexLaunchPlan: TEST_LAUNCH_PLAN }), /runtime_recovery_required/);
    assert.equal(await readRuntimeLock(layout), null);
  } finally {
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("onboarding is fenced by active runtime ownership", async function () {
  const temporary = await temporaryCodexRoot();
  const layout = buildLayout(temporary.root);
  let ownership = null;
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "session", runPreflight: preflightOk });
    ownership = await acquireRuntimeLock(layout, { now: Date.now() });
    await assert.rejects(onboard({ codexRoot: temporary.root, routeMode: "session", runPreflight: preflightOk }), /runtime_lock_busy/);
  } finally {
    if (ownership) {
      try { await releaseRuntimeLock(layout, ownership); } catch {}
    }
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("explicit runtime recovery clears only a healthy runtime latch", async function () {
  const temporary = await temporaryCodexRoot();
  const layout = buildLayout(temporary.root);
  let runtime = null;
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "session", runPreflight: preflightOk });
    const ownership = await acquireRuntimeLock(layout);
    await writeHeartbeat(layout, ownership, "RECOVERY_REQUIRED", 7, Date.now());
    assert.equal(await releaseRuntimeLock(layout, ownership), true);

    const result = await recoverRuntime({ codexRoot: temporary.root });
    assert.equal(result.status, "recovered");
    assert.equal(result.recovery, "runtime");
    assert.equal(result.restartRequired, true);
    assert.equal((await readHeartbeat(layout)).state, "STOPPED");
    assert.equal(await readRuntimeLock(layout), null);

    runtime = await startRuntime({
      codexRoot: temporary.root,
      runPreflight: preflightOk,
      codexLaunchPlan: TEST_LAUNCH_PLAN,
      appServerClient: new FakeAppServerClient(),
      heartbeatIntervalMs: 1000
    });
    assert.notEqual(runtime.status().status, "RECOVERY_REQUIRED");
    assert.deepEqual(await runtime.stop(), { status: "stopped" });
  } finally {
    if (runtime) {
      try { await runtime.stop(); } catch {}
    }
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("runtime recovery refuses active ownership and domain recovery rows", async function () {
  const temporary = await temporaryCodexRoot();
  const layout = buildLayout(temporary.root);
  let ownership = null;
  try {
    await onboard({ codexRoot: temporary.root, routeMode: "session", runPreflight: preflightOk });
    ownership = await acquireRuntimeLock(layout);
    await writeHeartbeat(layout, ownership, "RECOVERY_REQUIRED", 1, Date.now());
    await assert.rejects(recoverRuntime({ codexRoot: temporary.root }), /runtime_lock_busy/);
    assert.equal((await readHeartbeat(layout)).state, "RECOVERY_REQUIRED");
    assert.equal(await releaseRuntimeLock(layout, ownership), true);
    ownership = null;

    const storage = openStorage(layout.databaseFile, { create: false });
    try { storage.setRouteState("session", "RECOVERY_REQUIRED"); }
    finally { storage.close(); }
    await assert.rejects(recoverRuntime({ codexRoot: temporary.root }), /recovery_scope_incomplete/);
    assert.equal((await readHeartbeat(layout)).state, "RECOVERY_REQUIRED");
    assert.equal(await readRuntimeLock(layout), null);
  } finally {
    if (ownership) {
      try { await releaseRuntimeLock(layout, ownership); } catch {}
    }
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});

test("CLI exposes preflight and requires explicit runtime recovery confirmation", async function () {
  const temporary = await temporaryCodexRoot();
  const stdout = [];
  const stderr = [];
  try {
    const common = {
      codexRoot: temporary.root,
      stdout: { write: function (value) { stdout.push(value); } },
      stderr: { write: function (value) { stderr.push(value); } },
      env: { PATH: "fixture-path" },
      runPreflight: async function (options) {
        assert.equal(options.env.PATH, "fixture-path");
        return { ok: true, nodeVersion: "fixture" };
      },
      recoverRuntime: async function () { return { status: "not_required", recovery: "runtime", restartRequired: false }; }
    };
    assert.equal(await runCli(["preflight", "--json"], common), 0);
    assert.equal(JSON.parse(stdout.pop()).ok, true);
    common.runPreflight = async function () { const error = new Error("codex_login_status_failed"); error.code = "codex_login_status_failed"; throw error; };
    assert.equal(await runCli(["preflight", "--json"], common), 3);
    assert.equal(JSON.parse(stderr.pop()).error.code, "codex_login_status_failed");
    assert.equal(await runCli(["recover", "runtime"], common), 64);
    assert.equal(JSON.parse(stderr.pop()).error.code, "usage_invalid");
    assert.equal(await runCli(["recover", "runtime", "--confirm"], common), 0);
    assert.equal(JSON.parse(stdout.pop()).status, "not_required");
  } finally {
    await fsp.rm(temporary.parent, { recursive: true, force: true });
  }
});
