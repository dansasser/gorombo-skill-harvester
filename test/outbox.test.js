import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStorage } from "../src/storage.js";
import { acceptCompletion, claimAssessment, createCompletionEvent, persistCatalogSnapshot, publishRecommendation, recordAssessment } from "../src/harvester.js";
import { buildCatalogSnapshot } from "../src/catalog.js";
import { buildLayout } from "../src/paths.js";
import { claimNextDelivery, completeDelivery, enqueueTelegramRouteTest, OutboxDispatcher, recoverExpiredLeases, renderClaim, replayDelivery, resumeRoute, retryDueAt } from "../src/outbox.js";

async function queuedFixture(now = 1000) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-outbox-"));
  const codexRoot = path.join(root, "codex");
  const pluginRoot = path.join(root, "plugin");
  await fsp.mkdir(path.join(codexRoot, "skills"), { recursive: true });
  await fsp.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
  const layout = buildLayout(codexRoot);
  await fsp.mkdir(layout.recommendationsDir, { recursive: true });
  const storage = openStorage(":memory:", { create: true, now });
  storage.upsertRoute("telegram", true, "READY", {}, now);
  const event = createCompletionEvent({ taskId: "task", generation: 0, completedAt: now, sourceRevision: "rev", evidence: [{ kind: "user_request", text: "Repeat this safe process." }] });
  acceptCompletion(storage, event, now);
  const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot, pluginRoot }, now);
  persistCatalogSnapshot(storage, catalog, now);
  const claim = claimAssessment(storage, "assessment-worker", now);
  const result = recordAssessment(storage, claim, catalog, {
    decision: "propose-new",
    reasonSummary: "Reusable behavior.",
    recommendation: {
      contentSchemaVersion: 1,
      skillName: "Safe repeater",
      purpose: "Repeat a safe workflow.",
      whyRecommended: "The workflow is reusable.",
      whenToUse: ["The same workflow is requested."],
      suggestedProcedure: ["Run the bounded steps."],
      evidenceSummary: [],
      proposedFiles: [],
      resources: [],
      overlapSummary: "",
      exclusions: [],
      nextReviewAction: "Review the recommendation."
    }
  }, "test", now);
  await publishRecommendation(storage, layout, result.recommendationId, function () {}, now);
  return { root, storage, layout, recommendationId: result.recommendationId };
}

test("claim renders human-readable alert and accepted result is fenced", async function () {
  const x = await queuedFixture();
  try {
    const claim = claimNextDelivery(x.storage, "worker", 1000);
    const envelope = renderClaim(claim);
    assert.match(envelope.plainText, /Skill recommendation: Safe repeater/);
    assert.match(envelope.plainText, /Next: Review the recommendation/);
    const stale = { ...claim, leaseToken: "run_" + "0".repeat(32) };
    assert.equal(completeDelivery(x.storage, stale, { category: "accepted", providerReceiptRef: "1", safeReceipt: {} }, 1001).status, "stale");
    assert.equal(completeDelivery(x.storage, claim, { category: "accepted", providerReceiptRef: "1", safeReceipt: { method: "sendMessage", renderedDigest: envelope.renderedDigest } }, 1001).status, "sent");
    assert.equal(x.storage.db.prepare("SELECT state FROM delivery_outbox WHERE id=?").get(claim.deliveryId).state, "SENT");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("retry schedule and expired lease recovery are deterministic", async function () {
  assert.equal(retryDueAt(1, 1000), 6000);
  assert.equal(retryDueAt(7, 1000), 86_401_000);
  assert.equal(retryDueAt(8, 1000), null);
  const x = await queuedFixture();
  try {
    const claim = claimNextDelivery(x.storage, "worker", 1000);
    assert.equal(recoverExpiredLeases(x.storage, claim.leaseExpiresAt - 1), 0);
    assert.equal(recoverExpiredLeases(x.storage, claim.leaseExpiresAt), 1);
    const row = x.storage.db.prepare("SELECT state,ambiguous_acceptance,last_error_category FROM delivery_outbox WHERE id=?").get(claim.deliveryId);
    assert.equal(row.state, "RETRY_WAIT");
    assert.equal(row.ambiguous_acceptance, 1);
    assert.equal(row.last_error_category, "lease_expired");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("event-driven dispatcher sends queued work without a completion poll", async function () {
  const x = await queuedFixture();
  try {
    const sent = [];
    const dispatcher = new OutboxDispatcher({
      storage: x.storage,
      workerId: "dispatcher",
      adapters: {
        telegram: {
          async send(envelope) {
            sent.push(envelope.plainText);
            return { category: "accepted", providerReceiptRef: "message-one", safeReceipt: { method: "sendMessage", renderedDigest: envelope.renderedDigest } };
          }
        }
      }
    });
    dispatcher.start();
    const deadline = Date.now() + 2000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await dispatcher.stop();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Safe repeater/);
    assert.equal(x.storage.db.prepare("SELECT state FROM delivery_outbox").get().state, "SENT");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});


test("accepted receipts must bind the exact rendered digest", async function () {
  const x = await queuedFixture();
  try {
    const claim = claimNextDelivery(x.storage, "worker", 1000);
    const envelope = renderClaim(claim);
    assert.throws(function () {
      completeDelivery(x.storage, claim, { category: "accepted", providerReceiptRef: "1", safeReceipt: {} }, 1001);
    }, /adapter_result_invalid/);
    assert.throws(function () {
      completeDelivery(x.storage, claim, { category: "accepted", providerReceiptRef: "1", safeReceipt: { renderedDigest: "0".repeat(64) } }, 1001);
    }, /adapter_result_invalid/);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_receipts").get().n, 0);
    assert.equal(completeDelivery(x.storage, claim, { category: "accepted", providerReceiptRef: "1", safeReceipt: { renderedDigest: envelope.renderedDigest } }, 1001).status, "sent");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("delivery commits are fenced at lease expiry", async function () {
  const x = await queuedFixture();
  try {
    const claim = claimNextDelivery(x.storage, "worker", 1000);
    const envelope = renderClaim(claim);
    const result = completeDelivery(x.storage, claim, { category: "accepted", providerReceiptRef: "1", safeReceipt: { renderedDigest: envelope.renderedDigest } }, claim.leaseExpiresAt);
    assert.equal(result.status, "expired");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_receipts").get().n, 0);
    const row = x.storage.db.prepare("SELECT state,ambiguous_acceptance FROM delivery_outbox").get();
    assert.equal(row.state, "RETRY_WAIT");
    assert.equal(row.ambiguous_acceptance, 1);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("retry-after cap pauses instead of dead-lettering", async function () {
  assert.equal(retryDueAt(1, 1000, 86_401_000), 86_401_000);
  const x = await queuedFixture();
  try {
    const claim = claimNextDelivery(x.storage, "worker", 1000);
    const result = completeDelivery(x.storage, claim, { category: "rateLimited", retryAfterAt: 86_401_001, safeError: { code: "rate_limited" } }, 1000);
    assert.equal(result.status, "paused");
    const row = x.storage.db.prepare("SELECT state,last_error_category,terminal_at FROM delivery_outbox").get();
    assert.equal(row.state, "PAUSED");
    assert.equal(row.last_error_category, "retry_after_exceeds_policy");
    assert.equal(row.terminal_at, null);
    assert.equal(x.storage.db.prepare("SELECT state FROM route_configurations WHERE route='telegram'").get().state, "DEGRADED");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("integrity failure pauses delivery without calling the adapter", async function () {
  const x = await queuedFixture();
  try {
    x.storage.db.prepare("UPDATE recommendations SET canonical_json='{}' WHERE id=?").run(x.recommendationId);
    let calls = 0;
    const dispatcher = new OutboxDispatcher({
      storage: x.storage,
      workerId: "dispatcher",
      adapters: { telegram: { async send() { calls += 1; return { category: "accepted", providerReceiptRef: "1", safeReceipt: {} }; } } }
    });
    dispatcher.start();
    const deadline = Date.now() + 2000;
    while (x.storage.db.prepare("SELECT state FROM completion_events").get().state !== "RECOVERY_REQUIRED" && Date.now() < deadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 5); });
    }
    await dispatcher.stop();
    assert.equal(calls, 0);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events").get().state, "RECOVERY_REQUIRED");
    assert.equal(x.storage.db.prepare("SELECT state FROM delivery_outbox").get().state, "PAUSED");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

function createManualClock(now = 1000) {
  const timers = [];
  return {
    clock: {
      now: function () { return now; },
      setTimeout: function (callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: function (timer) { timer.cleared = true; },
      queueMicrotask
    },
    fire: function (delay) {
      const timer = timers.find(function (candidate) { return !candidate.cleared && candidate.delay === delay; });
      assert.ok(timer, `missing active timer for ${delay}ms`);
      timer.cleared = true;
      timer.callback();
    }
  };
}

async function waitForOutboxState(storage, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (storage.db.prepare("SELECT state FROM delivery_outbox").get().state === expected) return;
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  assert.fail(`outbox did not reach ${expected}`);
}

test("adapter deadline records ambiguity", async function () {
  const x = await queuedFixture();
  try {
    const manual = createManualClock();
    const dispatcher = new OutboxDispatcher({
      storage: x.storage,
      workerId: "dispatcher",
      adapters: { telegram: { async send() { return await new Promise(function () {}); } } },
      clock: manual.clock,
      attemptTimeoutMs: 30,
      stopGraceMs: 10
    });
    dispatcher.start();
    await waitForOutboxState(x.storage, "SENDING");
    manual.fire(30);
    await dispatcher.pump();
    const row = x.storage.db.prepare("SELECT state,ambiguous_acceptance,last_error_category FROM delivery_outbox").get();
    assert.equal(row.state, "RETRY_WAIT");
    assert.equal(row.ambiguous_acceptance, 1);
    assert.equal(row.last_error_category, "ambiguous");
    assert.equal((await dispatcher.stop()).status, "stopped");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("dispatcher stop returns after bounded grace when adapter ignores abort", async function () {
  const x = await queuedFixture();
  try {
    const manual = createManualClock();
    let aborted = false;
    const dispatcher = new OutboxDispatcher({
      storage: x.storage,
      workerId: "dispatcher",
      adapters: {
        telegram: {
          async send(_envelope, signal) {
            signal.addEventListener("abort", function () { aborted = true; }, { once: true });
            return await new Promise(function () {});
          }
        }
      },
      clock: manual.clock,
      attemptTimeoutMs: 500,
      stopGraceMs: 10
    });
    dispatcher.start();
    await waitForOutboxState(x.storage, "SENDING");
    const stopping = dispatcher.stop();
    manual.fire(10);
    const stopped = await stopping;
    assert.equal(stopped.status, "grace_expired");
    assert.equal(aborted, true);
    const lease = x.storage.db.prepare("SELECT lease_expires_at FROM delivery_outbox").get();
    recoverExpiredLeases(x.storage, lease.lease_expires_at);
    const row = x.storage.db.prepare("SELECT state,ambiguous_acceptance,last_error_category FROM delivery_outbox").get();
    assert.equal(row.state, "RETRY_WAIT");
    assert.equal(row.ambiguous_acceptance, 1);
    assert.equal(row.last_error_category, "lease_expired");
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});


test("generic route resume cannot bypass session reselection", async function () {
  const x = await queuedFixture();
  try {
    assert.throws(function () { resumeRoute(x.storage, "session", 1000); }, /session_reselection_required/);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});


function routeTestFixture(now = 1000) {
  const storage = openStorage(":memory:", { create: true, now });
  storage.upsertRoute("telegram", true, "CONFIGURED", {}, now);
  const bindingId = "bnd_" + "a".repeat(32);
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,is_primary,state,approved_at) VALUES(?,?,?,?,1,'ACTIVE',?)").run(bindingId, "123456", "7", "7", now);
  storage.db.prepare("INSERT INTO onboarding_runs(id,state,requested_route_mode,plan_json,safe_reason_code,started_at) VALUES(?,?,?,?,?,?)").run("onb_" + "b".repeat(32), "WAITING_FOR_ROUTE_CONFIGURATION", "telegram", "{}", null, now);
  const queued = enqueueTelegramRouteTest(storage, { botIdentity: "123456", allowedUsers: new Set(["7"]) }, now);
  return { storage, bindingId, queued };
}

test("Telegram route test uses the durable outbox and atomically makes its revision ready", function () {
  const x = routeTestFixture();
  try {
    assert.equal(x.queued.status, "queued");
    assert.equal(x.storage.getRoute("telegram").state, "VERIFYING");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM recommendations").get().count, 0);
    const row=x.storage.db.prepare("SELECT delivery_kind,target_binding_id,test_message,test_message_digest FROM delivery_outbox").get();
    assert.equal(row.delivery_kind,"route_test");
    assert.equal(row.target_binding_id,x.bindingId);
    assert.match(row.test_message,/No skill recommendation was created/);
    assert.equal(row.test_message_digest,x.queued.renderedDigest);
    const duplicate=enqueueTelegramRouteTest(x.storage,{botIdentity:"123456",allowedUsers:new Set(["7"])},1001);
    assert.equal(duplicate.deliveryId,x.queued.deliveryId);
    const claim=claimNextDelivery(x.storage,"route-test-worker",1001),envelope=renderClaim(claim);
    assert.equal(envelope.targetBindingId,x.bindingId);
    const completed=completeDelivery(x.storage,claim,{category:"accepted",providerReceiptRef:"42",safeReceipt:{method:"sendMessage",renderedDigest:envelope.renderedDigest}},1002);
    assert.equal(completed.status,"sent");
    assert.equal(x.storage.getRoute("telegram").state,"READY");
    assert.equal(x.storage.getRoute("telegram").revision,1);
    const receipt=x.storage.db.prepare("SELECT delivery_id,configuration_revision,test_generation FROM route_test_receipts").get();
    assert.equal(receipt.delivery_id,x.queued.deliveryId);
    assert.equal(receipt.configuration_revision,1);
    assert.equal(receipt.test_generation,0);
    assert.equal(x.storage.db.prepare("SELECT state FROM onboarding_runs").get().state,"COMPLETED");
  } finally { x.storage.close(); }
});

test("accepted stale Telegram test is receipted without readying a changed destination", function () {
  const x=routeTestFixture();
  try {
    const claim=claimNextDelivery(x.storage,"route-test-worker",1000),envelope=renderClaim(claim);
    x.storage.configureRoute("telegram",true,"CONFIGURED",{},1001);
    const completed=completeDelivery(x.storage,claim,{category:"accepted",providerReceiptRef:"43",safeReceipt:{method:"sendMessage",renderedDigest:envelope.renderedDigest}},1002);
    assert.equal(completed.status,"sent_stale_configuration");
    assert.equal(x.storage.getRoute("telegram").state,"CONFIGURED");
    assert.equal(x.storage.getRoute("telegram").revision,2);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM route_test_receipts").get().count,1);
    assert.throws(function(){replayDelivery(x.storage,x.queued.deliveryId,"rpl_"+"c".repeat(32),"test","route test",1003);},/replay_not_allowed/);
  } finally { x.storage.close(); }
});
