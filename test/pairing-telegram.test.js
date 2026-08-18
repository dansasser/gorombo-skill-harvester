import assert from "node:assert/strict";
import test from "node:test";
import { openStorage } from "../src/storage.js";
import { activeBinding, approvePairing, beginPairing, legacyPairingCodeDigest, primaryTelegramBinding } from "../src/pairing.js";
import { TelegramClient, telegramCommand, telegramMessage } from "../src/telegram.js";

const fakeToken = ["123456", "abcdefghijklmnopqrstuv"].join(":");

test("pairing is allowed-user ready, expiring, single-use, and private", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const token = fakeToken;
    const pending = beginPairing(storage, {
      token, botIdentity: "123456", userIdentity: "246802468", chatIdentity: "246802468", chatType: "private",
      randomBytes: function () { return Buffer.from("a1b2c3", "hex"); }
    }, 1000);
    assert.equal(pending.code, "A1B2C3");
    assert.equal(storage.db.prepare("SELECT code_digest FROM pairing_requests").get().code_digest.includes("A1B2C3"), false);
    const binding = approvePairing(storage, { token, botIdentity: "123456", code: pending.code }, 1001);
    assert.equal(binding.userIdentity, "246802468");
    assert.equal(activeBinding(storage, "123456", "246802468", "246802468").id, binding.bindingId);
    assert.throws(function () { approvePairing(storage, { token, botIdentity: "123456", code: pending.code }, 1002); }, /pairing_code_invalid/);
  } finally {
    storage.close();
  }
});

test("non-private pairing is rejected before durable state", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    assert.throws(function () {
      beginPairing(storage, { token: fakeToken, botIdentity: "123456", userIdentity: "7", chatIdentity: "-1007", chatType: "group", randomBytes: function () { return Buffer.from("ffffff", "hex"); } }, 1);
    }, /pairing_input_invalid/);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests").get().count, 0);
  } finally { storage.close(); }
});

test("expired pairing code cannot be approved", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const options = { token: fakeToken, botIdentity: "123456", userIdentity: "7", chatIdentity: "7", chatType: "private", randomBytes: function () { return Buffer.from("ffffff", "hex"); } };
    const pending = beginPairing(storage, options, 0);
    assert.throws(function () { approvePairing(storage, { token: options.token, botIdentity: options.botIdentity, code: pending.code }, 3_600_001); }, /pairing_code_invalid/);
  } finally {
    storage.close();
  }
});

test("a pending code created by the previous product identity remains approvable", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  try {
    const options = { token: fakeToken, botIdentity: "123456", userIdentity: "7", chatIdentity: "7", chatType: "private", randomBytes: function () { return Buffer.from("112233", "hex"); } };
    const pending = beginPairing(storage, options, 1000);
    const legacyDigest = legacyPairingCodeDigest(options.token, options.botIdentity, pending.code);
    storage.db.prepare("UPDATE pairing_requests SET code_digest=? WHERE id=?").run(legacyDigest, pending.requestId);
    const binding = approvePairing(storage, { token: options.token, botIdentity: options.botIdentity, code: pending.code }, 1001);
    assert.equal(binding.userIdentity, "7");
  } finally { storage.close(); }
});

test("Telegram update and control commands are bounded", function () {
  const parsed = telegramMessage({ update_id: 9, message: { from: { id: 7 }, chat: { id: 7, type: "private" }, text: " hello " } });
  assert.deepEqual(parsed, { updateIdentity: "9", userIdentity: "7", chatIdentity: "7", chatType: "private", text: "hello", hasAttachment: false });
  assert.equal(telegramCommand("/start"), "start");
  assert.equal(telegramCommand("/status@MyBot", "mybot"), "status");
  assert.equal(telegramCommand("/status@OtherBot", "mybot"), null);
});

test("Telegram sends readable text and classifies provider results", async function () {
  const requests = [];
  const accepted = new TelegramClient({
    token: fakeToken,
    fetch: async function (url, init) {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await accepted.sendText("7", "Skill recommendation: Example\nNext: Review it.");
  assert.equal(result.category, "accepted");
  assert.equal(result.providerReceiptRef, "42");
  assert.equal(requests[0].body.chat_id, "7");
  assert.match(requests[0].body.text, /Skill recommendation/);

  const limited = new TelegramClient({
    token: fakeToken,
    fetch: async function () {
      return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 5 } }), { status: 429 });
    },
    now: function () { return 1000; }
  });
  const retry = await limited.sendText("7", "test");
  assert.equal(retry.category, "rateLimited");
  assert.equal(retry.retryAfterAt, 6000);
});


test("pairing approval selects one primary destination and revises its route", function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const token = fakeToken;
  try {
    storage.upsertRoute("telegram", true, "CONFIGURED", {}, 1);
    const first = beginPairing(storage, { token, botIdentity: "123456", userIdentity: "7", chatIdentity: "7", chatType: "private", randomBytes: function () { return Buffer.from("010203", "hex"); } }, 2);
    approvePairing(storage, { token, botIdentity: "123456", code: first.code }, 3);
    assert.equal(storage.getRoute("telegram").revision, 2);
    const second = beginPairing(storage, { token, botIdentity: "123456", userIdentity: "8", chatIdentity: "8", chatType: "private", randomBytes: function () { return Buffer.from("040506", "hex"); } }, 4);
    const approved = approvePairing(storage, { token, botIdentity: "123456", code: second.code }, 5);
    assert.equal(storage.getRoute("telegram").revision, 3);
    assert.equal(primaryTelegramBinding(storage, "123456", new Set(["7", "8"])).id, approved.bindingId);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM telegram_bindings WHERE is_primary=1").get().count, 1);
    assert.equal(storage.db.prepare("SELECT is_primary FROM telegram_bindings WHERE user_identity='7'").get().is_primary, 0);
  } finally { storage.close(); }
});
