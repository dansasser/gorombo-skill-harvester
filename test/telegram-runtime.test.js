import assert from "node:assert/strict";
import test from "node:test";
import { approvePairing, revokeBinding } from "../src/pairing.js";
import { processTelegramUpdate, readTelegramCursor } from "../src/telegram-inbound.js";
import { claimNextDelivery, completeDelivery, enqueueTelegramRouteTest, renderClaim } from "../src/outbox.js";
import { TelegramReplyDispatcher, claimTelegramReply, completeTelegramReply, queueTelegramReply, recoverExpiredTelegramReplyLeases } from "../src/telegram-replies.js";
import { TelegramUpdateLoop } from "../src/telegram-update-loop.js";
import { openStorage } from "../src/storage.js";

const BOT = "100";
const USER = "200";
const TOKEN = "100:abcdefghijklmnopqrstuvwxyz";
const BINDING = "bnd_0123456789abcdef0123456789abcdef";

function update(id, text, options = {}) {
  return {
    update_id: id,
    message: {
      from: { id: options.user || Number(USER) },
      chat: { id: options.chat || Number(USER), type: options.chatType || "private" },
      text,
      ...(options.attachment ? { document: { file_id: "private" } } : {})
    }
  };
}

function context() {
  return {
    botIdentity: BOT,
    username: "gorombo_skill_harvester_bot",
    token: TOKEN,
    allowedUsers: new Set([USER]),
    randomBytes: function () { return Buffer.from([0x1a, 0x2d, 0xb1]); }
  };
}

function installBinding(storage) {
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,state,approved_at) VALUES(?,?,?,?, 'ACTIVE',1)")
    .run(BINDING, BOT, USER, USER);
  return BINDING;
}

function quickClock() {
  return {
    now: Date.now,
    setTimeout: function (callback) { return setTimeout(callback, 1); },
    clearTimeout,
    queueMicrotask
  };
}

async function eventually(predicate, timeoutMs = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("eventually_timeout");
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
}

test("Telegram pairing requires a durable route test before text queues one task", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  try {
    const first = processTelegramUpdate(storage, update(1, "/start"), context(), 10);
    assert.equal(first.status, "pairing_requested");
    assert.equal(first.cursor, 2);
    assert.equal(readTelegramCursor(storage), 2);
    assert.equal(storage.db.prepare("SELECT state FROM telegram_updates WHERE update_identity='1'").get().state, "HANDLED");
    assert.equal(storage.db.prepare("SELECT state FROM pairing_requests").get().state, "PENDING");
    const queued = storage.db.prepare("SELECT message_private,state FROM telegram_reply_deliveries").get();
    assert.equal(queued.state, "QUEUED");
    assert.match(queued.message_private, /pairing code: 1A2DB1/);
    assert.match(queued.message_private, /gorombo-skill-harvester pair 1A2DB1/);
    assert.equal(queued.message_private.includes(TOKEN), false);

    const sent = [];
    const dispatcher = new TelegramReplyDispatcher({
      storage,
      client: {
        sendText: async function (chatIdentity, message) {
          sent.push({ chatIdentity, message });
          return { category: "accepted", providerReceiptRef: "7", safeReceipt: { method: "sendMessage" } };
        }
      },
      attemptTimeoutMs: 1000
    });
    dispatcher.start();
    await eventually(function () {
      return storage.db.prepare("SELECT state FROM telegram_reply_deliveries").get().state === "SENT";
    });
    await dispatcher.stop();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatIdentity, USER);

    const code = queued.message_private.match(/pairing code: ([0-9A-F]{6})/u)[1];
    const approved = approvePairing(storage, { code, botIdentity: BOT, token: TOKEN }, 20);
    assert.ok(approved.bindingId);
    assert.equal(approved.wakeReplies, true);
    const confirmation = storage.db.prepare("SELECT binding_id,message_private,state FROM telegram_reply_deliveries WHERE purpose='CONFIRMATION'").get();
    assert.equal(confirmation.binding_id, approved.bindingId);
    assert.equal(confirmation.state, "QUEUED");
    assert.match(confirmation.message_private, /pairing approved/i);
    assert.match(confirmation.message_private, /route test/i);

    const beforeTest = processTelegramUpdate(storage, update(2, "This must wait for route verification."), context(), 30);
    assert.equal(beforeTest.status, "rejected");
    assert.equal(beforeTest.reason, "route_not_ready");
    assert.equal(beforeTest.wakeReplies, true);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);

    const routeTest = enqueueTelegramRouteTest(storage, { botIdentity: BOT, allowedUsers: new Set([USER]) }, 31);
    const routeClaim = claimNextDelivery(storage, "route-test-worker", 32);
    const routeEnvelope = renderClaim(routeClaim);
    assert.equal(routeClaim.deliveryId, routeTest.deliveryId);
    const tested = completeDelivery(storage, routeClaim, {
      category: "accepted",
      providerReceiptRef: "8",
      safeReceipt: { method: "sendMessage", renderedDigest: routeEnvelope.renderedDigest }
    }, 33);
    assert.equal(tested.status, "sent");
    assert.equal(storage.getRoute("telegram").state, "READY");

    const task = processTelegramUpdate(storage, update(3, "Inspect the project and report the result."), context(), 40);
    assert.equal(task.status, "queued");
    assert.equal(task.wakeTasks, true);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    const duplicate = processTelegramUpdate(storage, update(3, "This must not create another task."), context(), 41);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);

    const status = processTelegramUpdate(storage, update(4, "/status"), context(), 50);
    assert.equal(status.command, "status");
    const statusReply = storage.db.prepare("SELECT message_private FROM telegram_reply_deliveries WHERE purpose='STATUS'").get();
    assert.match(statusReply.message_private, /Tasks: 1 queued/);
    assert.ok(statusReply.message_private.includes(task.taskId));
    assert.match(statusReply.message_private, /\(queued\)/);

    const unauthorized = processTelegramUpdate(storage, update(5, "/status", { user: 999, chat: 999 }), context(), 60);
    assert.equal(unauthorized.reason, "user_not_allowed");
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_reply_deliveries").get().count, 4);

    const cancelled = processTelegramUpdate(storage, update(6, "/cancel"), context(), 70);
    assert.equal(cancelled.command, "cancel");
    assert.equal(cancelled.abortTaskId, null);
    assert.equal(cancelled.wakeReplies, false);
    assert.equal(cancelled.wakeTaskResults, true);
    assert.equal(storage.db.prepare("SELECT state FROM tasks").get().state, "CANCELLED");
    const cancellation = storage.db.prepare("SELECT message_private,state FROM task_result_deliveries").get();
    assert.equal(cancellation.state, "QUEUED");
    assert.ok(cancellation.message_private.includes(task.taskId));
    assert.equal(readTelegramCursor(storage), 7);
  } finally {
    storage.close();
  }
});

test("non-private Telegram updates never pair, command, reply, or queue tasks", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 }); storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  try {
    const cases = [["group", "/start"],["supergroup", "/status"],["channel", "/help"],["group", "/cancel"],["supergroup", "/unknown"],["group", "Run a Codex task."]];
    for (let index = 0; index < cases.length; index += 1) { const result = processTelegramUpdate(storage, update(index + 1, cases[index][1], { chat: -100, chatType: cases[index][0] }), context(), 10 + index); assert.equal(result.status, "rejected"); assert.equal(result.reason, "private_chat_required"); assert.equal(result.wakeReplies, false); assert.equal(result.wakeTasks, false); }
    assert.equal(readTelegramCursor(storage), cases.length + 1);
    for (const table of ["pairing_requests","telegram_bindings","telegram_reply_deliveries","tasks"]) assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count, 0);
  } finally { storage.close(); }
});

test("Telegram reply completion is receipt-digest fenced and lease recovery records ambiguity", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "READY", {}, 1);
  const bindingId = installBinding(storage);
  try {
    queueTelegramReply(storage, {
      sourceIdentity: "update:10",
      purpose: "HELP",
      bindingId,
      chatIdentity: USER,
      message: "Safe help message."
    }, 10);
    const claim = claimTelegramReply(storage, "worker", 11);
    assert.throws(function () {
      completeTelegramReply(storage, claim, {
        category: "accepted",
        providerReceiptRef: "9",
        safeReceipt: { method: "sendMessage", messageDigest: "0".repeat(64) }
      }, 12);
    }, /telegram_reply_result_invalid/);
    assert.equal(storage.db.prepare("SELECT state FROM telegram_reply_deliveries").get().state, "SENDING");
    assert.equal(completeTelegramReply(storage, claim, {
      category: "accepted",
      providerReceiptRef: "9",
      safeReceipt: { method: "sendMessage", messageDigest: claim.messageDigest }
    }, 12).status, "sent");

    queueTelegramReply(storage, {
      sourceIdentity: "update:11",
      purpose: "STATUS",
      bindingId,
      chatIdentity: USER,
      message: "Safe status message."
    }, 20);
    const second = claimTelegramReply(storage, "worker", 21);
    completeTelegramReply(storage, second, { category: "ambiguous", safeError: { code: "unknown_acceptance" } }, 22);
    const retry = storage.db.prepare("SELECT * FROM telegram_reply_deliveries WHERE source_identity='update:11'").get();
    assert.equal(retry.state, "RETRY_WAIT");
    assert.equal(retry.ambiguous_acceptance, 1);
    const third = claimTelegramReply(storage, "worker", Number(retry.next_attempt_at));
    assert.equal(recoverExpiredTelegramReplyLeases(storage, Number(third.leaseExpiresAt)), 1);
    const recovered = storage.db.prepare("SELECT * FROM telegram_reply_deliveries WHERE source_identity='update:11'").get();
    assert.equal(recovered.last_error_category, "lease_expired");
    assert.equal(recovered.ambiguous_acceptance, 1);
  } finally {
    storage.close();
  }
});

test("revoked bindings and disabled routes are rechecked before reply send", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "READY", {}, 1);
  const bindingId = installBinding(storage);
  try {
    queueTelegramReply(storage, {
      sourceIdentity: "update:20",
      purpose: "STATUS",
      bindingId,
      chatIdentity: USER,
      message: "Private status."
    }, 10);
    revokeBinding(storage, bindingId, 11);
    assert.equal(claimTelegramReply(storage, "worker", 12), null);

    queueTelegramReply(storage, {
      sourceIdentity: "update:21",
      purpose: "PAIRING",
      chatIdentity: USER,
      message: "Pairing code."
    }, 13);
    assert.match(claimTelegramReply(storage, "worker", 14).message, /Pairing code/);

    storage.upsertRoute("telegram", false, "DISABLED", {}, 15);
    queueTelegramReply(storage, {
      sourceIdentity: "update:22",
      purpose: "REJECTION",
      chatIdentity: USER,
      message: "Safe rejection."
    }, 16);
    assert.equal(claimTelegramReply(storage, "worker", 17), null);
  } finally {
    storage.close();
  }
});

test("Telegram update loop keeps one long poll and commits cursor after durable processing", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const client = {
    getUpdates: async function (offset, signal) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        assert.equal(offset, 0);
        active -= 1;
        return [update(1, "/start")];
      }
      return await new Promise(function (_resolve, reject) {
        signal.addEventListener("abort", function () {
          active -= 1;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
  };
  let replyWake = 0;
  const loop = new TelegramUpdateLoop({
    storage,
    client,
    context: context(),
    onResult: async function (result) { if (result.wakeReplies) replyWake += 1; },
    stopGraceMs: 100
  });
  try {
    loop.start();
    await eventually(function () { return readTelegramCursor(storage) === 2 && calls >= 2; });
    const stopped = await loop.stop();
    assert.equal(stopped.status, "stopped");
    assert.equal(maxActive, 1);
    assert.equal(replyWake, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests").get().count, 1);
  } finally {
    storage.close();
  }
});

test("committed wake failures retry the wake without duplicating durable work", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  let calls = 0;
  const client = {
    getUpdates: async function (_offset, signal) {
      calls += 1;
      if (calls === 1) return [update(1, "/start")];
      return await new Promise(function (_resolve, reject) {
        signal.addEventListener("abort", function () { reject(new Error("aborted")); }, { once: true });
      });
    }
  };
  let wakeAttempts = 0;
  const loop = new TelegramUpdateLoop({
    storage,
    client,
    context: context(),
    clock: quickClock(),
    onResult: async function () {
      wakeAttempts += 1;
      if (wakeAttempts === 1) throw new Error("token=private C:\\private");
    },
    stopGraceMs: 100
  });
  try {
    loop.start();
    await eventually(function () { return wakeAttempts >= 2 && calls >= 2; });
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests").get().count, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_reply_deliveries").get().count, 1);
    assert.equal(readTelegramCursor(storage), 2);
    assert.equal(loop.status().errorCode, null);
    await loop.stop();
  } finally {
    storage.close();
  }
});

test("out-of-order batches are sorted before cursor commits", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  let calls = 0;
  const seen = [];
  let failAfterFirstCommit = true;
  const client = {
    getUpdates: async function (offset, signal) {
      calls += 1;
      if (calls === 1) {
        assert.equal(offset, 0);
        return [update(2, "/help"), update(1, "/start")];
      }
      if (calls === 2) {
        assert.equal(offset, 2);
        return [update(2, "/help")];
      }
      return await new Promise(function (_resolve, reject) {
        signal.addEventListener("abort", function () { reject(new Error("aborted")); }, { once: true });
      });
    }
  };
  const loop = new TelegramUpdateLoop({
    storage,
    client,
    context: context(),
    clock: quickClock(),
    processUpdate: function (...args) {
      seen.push(args[1].update_id);
      const result = processTelegramUpdate(...args);
      if (failAfterFirstCommit) {
        failAfterFirstCommit = false;
        throw new Error("simulated_boundary_failure");
      }
      return result;
    },
    stopGraceMs: 100
  });
  try {
    loop.start();
    await eventually(function () { return readTelegramCursor(storage) === 3 && calls >= 3; });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_updates").get().count, 2);
    await loop.stop();
  } finally {
    storage.close();
  }
});

test("duplicate update ids fail the batch before cursor advance and errors stay generic", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
  let calls = 0;
  const client = {
    getUpdates: async function (_offset, signal) {
      calls += 1;
      if (calls === 1) return [update(1, "/start"), update(1, "/start")];
      return await new Promise(function (_resolve, reject) {
        signal.addEventListener("abort", function () { reject(new Error("token=private C:\\private")); }, { once: true });
      });
    }
  };
  const loop = new TelegramUpdateLoop({
    storage,
    client,
    context: context(),
    clock: quickClock(),
    stopGraceMs: 100
  });
  try {
    loop.start();
    await eventually(function () { return calls >= 2; });
    assert.equal(readTelegramCursor(storage), 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_updates").get().count, 0);
    assert.equal(loop.status().errorCode, "telegram_updates_contract_invalid");
    assert.equal(JSON.stringify(loop.status()).includes("private"), false);
    await loop.stop();
  } finally {
    storage.close();
  }
});
