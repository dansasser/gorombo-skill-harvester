import assert from "node:assert/strict";
import test from "node:test";
import {
  claimExternalAlert,
  completeExternalAlert,
  enqueueExternalTelegramAlert,
  ExternalAlertDispatcher,
  normalizeExternalAlertBody
} from "../src/external-alerts.js";
import { openStorage } from "../src/storage.js";

function fixture(now = 1000) {
  const storage = openStorage(":memory:", { create: true, now });
  storage.upsertRoute("telegram", true, "READY", {}, now);
  const bindingId = "bnd_" + "a".repeat(32);
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,is_primary,state,approved_at) VALUES(?,?,?,?,1,'ACTIVE',?)")
    .run(bindingId, "100", "200", "200", now);
  return { storage, bindingId };
}

test("external alert intake labels the external Harvester source and deduplicates the exact stable key", function () {
  const x = fixture();
  try {
    const input = { key: "harvester.propose-new:proposal-1", message: "Gorombo Skill Harvester recommends a new skill", targetBindingId: x.bindingId };
    assert.deepEqual(enqueueExternalTelegramAlert(x.storage, input, 1000), { result: "queued" });
    assert.deepEqual(enqueueExternalTelegramAlert(x.storage, input, 1001), { result: "existing" });
    assert.throws(function () {
      enqueueExternalTelegramAlert(x.storage, { ...input, message: "Different content" }, 1002);
    }, /external_alert_key_conflict/);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM external_alert_deliveries").get().count, 1);
    const claim = claimExternalAlert(x.storage, "worker", 1002, x.bindingId);
    assert.equal(claim.targetBindingId, x.bindingId);
    assert.match(claim.message, /^Source: External Harvester\n\nGorombo Skill Harvester recommends/u);
    assert.equal(completeExternalAlert(x.storage, claim, {
      category: "accepted",
      providerReceiptRef: "42",
      safeReceipt: { method: "sendMessage", renderedDigest: claim.messageDigest }
    }, 1003).status, "sent");
    const columns = x.storage.db.prepare("PRAGMA table_info(external_alert_deliveries)").all().map(function (row) { return row.name; });
    assert.equal(columns.includes("chat_identity_private"), false);
    assert.equal(columns.includes("target_binding_id"), false);
  } finally {
    x.storage.close();
  }
});

test("external alert intake rejects unsafe, oversized, and unready messages", function () {
  assert.throws(function () { normalizeExternalAlertBody(""); }, /external_alert_message_invalid/);
  assert.throws(function () { normalizeExternalAlertBody("x".repeat(4096)); }, /external_alert_message_invalid/);
  assert.throws(function () { normalizeExternalAlertBody("token=private-value"); }, /external_alert_message_invalid/);
  const x = fixture();
  try {
    x.storage.setRouteState("telegram", "DEGRADED", 1001);
    assert.throws(function () {
      enqueueExternalTelegramAlert(x.storage, { key: "key-1", message: "Safe message", targetBindingId: x.bindingId }, 1001);
    }, /telegram_route_not_ready/);
  } finally {
    x.storage.close();
  }
});

test("route-blocked external send degrades Telegram and stops later claims", async function () {
  const x = fixture();
  let calls = 0;
  const dispatcher = new ExternalAlertDispatcher({
    storage: x.storage,
    workerId: "external-worker",
    adapter: {
      async send() {
        calls += 1;
        return { category: "routeBlocked", safeError: { code: "telegram_route_blocked" } };
      }
    },
    resolveBinding: function () { return { id: x.bindingId }; }
  });
  try {
    enqueueExternalTelegramAlert(x.storage, { key: "key-1", message: "First safe alert", targetBindingId: x.bindingId }, 1000);
    enqueueExternalTelegramAlert(x.storage, { key: "key-2", message: "Second safe alert", targetBindingId: x.bindingId }, 1000);
    dispatcher.start();
    const deadline = Date.now() + 2000;
    while (x.storage.getRoute("telegram").state !== "DEGRADED" && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 5); });
    assert.equal(x.storage.getRoute("telegram").state, "DEGRADED");
    assert.equal(calls, 1);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM external_alert_deliveries WHERE state='QUEUED'").get().count, 1);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM external_alert_deliveries WHERE state='RETRY_WAIT'").get().count, 1);
  } finally {
    await dispatcher.stop();
    x.storage.close();
  }
});

test("external alerts select only the current bot binding after token rotation", function () {
  const x = fixture();
  try {
    const currentBindingId = "bnd_" + "b".repeat(32);
    x.storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,is_primary,state,approved_at) VALUES(?,?,?,?,1,'ACTIVE',?)")
      .run(currentBindingId, "101", "201", "201", 1001);
    assert.deepEqual(enqueueExternalTelegramAlert(x.storage, {
      key: "key-rotation",
      message: "Token rotation safe alert",
      targetBindingId: currentBindingId
    }, 1001), { result: "queued" });
    const claim = claimExternalAlert(x.storage, "worker", 1001, currentBindingId);
    assert.equal(claim.targetBindingId, currentBindingId);
  } finally {
    x.storage.close();
  }
});
