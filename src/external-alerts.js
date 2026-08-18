import {
  DELIVERY_ATTEMPT_TIMEOUT_MS,
  DELIVERY_LEASE_MS,
  DELIVERY_RETRY_DELAYS_MS,
  MAX_DELIVERY_ATTEMPTS,
  TELEGRAM_MESSAGE_LIMIT
} from "./constants.js";
import { scanSafeContent } from "./content.js";
import { createId, sha256 } from "./ids.js";

export const EXTERNAL_ALERT_SOURCE = "external-harvester";
export const EXTERNAL_ALERT_LABEL = "External Harvester";
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const BINDING_PATTERN = /^bnd_[0-9a-f]{32}$/u;
const READY_ROUTE = "EXISTS(SELECT 1 FROM route_configurations q WHERE q.route='telegram' AND q.selected=1 AND q.state='READY')";

export function normalizeExternalAlertKey(value) {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) throw new Error("external_alert_key_invalid");
  return value;
}

export function normalizeExternalAlertBody(value) {
  if (typeof value !== "string" || value.includes("\ufffd")) throw new Error("external_alert_message_invalid");
  const body = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const message = `Source: ${EXTERNAL_ALERT_LABEL}\n\n${body}`;
  if (!body || Array.from(message).length > TELEGRAM_MESSAGE_LIMIT || Buffer.byteLength(message, "utf8") > 16_384 || !scanSafeContent(message).ok) {
    throw new Error("external_alert_message_invalid");
  }
  return body;
}

function renderedMessage(body) {
  return `Source: ${EXTERNAL_ALERT_LABEL}\n\n${body}`;
}

function activeBindingById(storage, bindingId) {
  if (typeof bindingId !== "string" || !BINDING_PATTERN.test(bindingId)) return null;
  return storage.db.prepare("SELECT id FROM telegram_bindings WHERE id=? AND chat_type='private' AND state='ACTIVE' AND is_primary=1").get(bindingId) || null;
}

function routeReady(storage) {
  const route = storage.getRoute("telegram");
  return Boolean(route && route.selected && route.state === "READY");
}

export function enqueueExternalTelegramAlert(storage, input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("external_alert_invalid");
  const key = normalizeExternalAlertKey(input.key);
  const body = normalizeExternalAlertBody(input.message);
  if (typeof input.targetBindingId !== "string" || !BINDING_PATTERN.test(input.targetBindingId)) throw new Error("external_alert_binding_invalid");
  const message = renderedMessage(body);
  const digest = sha256(Buffer.from(message, "utf8"));
  return storage.transaction(function () {
    if (!routeReady(storage)) throw new Error("telegram_route_not_ready");
    const binding = activeBindingById(storage, input.targetBindingId);
    if (!binding || binding.id !== input.targetBindingId) throw new Error("telegram_unpaired");
    const existing = storage.db.prepare("SELECT message_digest,message_private FROM external_alert_deliveries WHERE source=? AND external_key=?")
      .get(EXTERNAL_ALERT_SOURCE, key);
    if (existing) {
      if (existing.message_digest !== digest || existing.message_private !== message) throw new Error("external_alert_key_conflict");
      return { result: "existing" };
    }
    storage.db.prepare("INSERT INTO external_alert_deliveries(id,source,external_key,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'QUEUED',?,?,?,?,?)")
      .run(createId("out"), EXTERNAL_ALERT_SOURCE, key, message, digest, now, now, now);
    return { result: "queued" };
  });
}

function retryDueAt(attemptNumber, now, retryAfterAt = null) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return null;
  const normal = now + DELIVERY_RETRY_DELAYS_MS[attemptNumber - 1];
  if (retryAfterAt === null) return normal;
  if (!Number.isSafeInteger(retryAfterAt) || retryAfterAt <= now || retryAfterAt > now + 7 * 24 * 60 * 60 * 1000) throw new Error("external_alert_result_invalid");
  return Math.max(normal, retryAfterAt);
}

function safeErrorCode(result) {
  const value = result && result.safeError && result.safeError.code;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "external_alert_failed";
}

function recoverExpiredRows(storage, now) {
  const rows = storage.db.prepare("SELECT id,attempt_count,lease_token FROM external_alert_deliveries WHERE state='SENDING' AND lease_expires_at<=? ORDER BY lease_expires_at,id").all(now);
  for (const row of rows) {
    const due = retryDueAt(Number(row.attempt_count), now);
    const state = due === null ? "DEAD_LETTER" : "RETRY_WAIT";
    storage.db.prepare("UPDATE external_alert_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='lease_expired',ambiguous_acceptance=1,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_expires_at<=?")
      .run(state, due === null ? now : due, now, state === "DEAD_LETTER" ? now : null, row.id, row.lease_token, now);
  }
  return rows.length;
}

export function recoverExpiredExternalAlertLeases(storage, now = Date.now()) {
  return storage.transaction(function () { return recoverExpiredRows(storage, now); });
}

export function claimExternalAlert(storage, workerId, now = Date.now(), targetBindingId = null) {
  if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128) throw new Error("external_alert_worker_invalid");
  return storage.transaction(function () {
    recoverExpiredRows(storage, now);
    const binding = activeBindingById(storage, targetBindingId);
    if (!binding) return null;
    const row = storage.db.prepare(
      "SELECT d.* FROM external_alert_deliveries d WHERE d.state IN ('QUEUED','RETRY_WAIT') AND d.next_attempt_at<=? AND " + READY_ROUTE +
      " ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1"
    ).get(now);
    if (!row) return null;
    const token = createId("run");
    const attemptNumber = Number(row.attempt_count) + 1;
    const changed = storage.db.prepare("UPDATE external_alert_deliveries SET state='SENDING',attempt_count=?,lease_token=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','RETRY_WAIT')")
      .run(attemptNumber, token, workerId, now + DELIVERY_LEASE_MS, now, row.id);
    if (Number(changed.changes) !== 1) return null;
    return {
      deliveryId: row.id,
      targetBindingId: binding.id,
      message: row.message_private,
      messageDigest: row.message_digest,
      attemptNumber,
      leaseToken: token,
      leaseOwner: workerId,
      leaseExpiresAt: now + DELIVERY_LEASE_MS
    };
  });
}

export function externalAlertClaimReady(storage, claim, now = Date.now(), targetBindingId = null) {
  if (!claim) return false;
  const binding = activeBindingById(storage, targetBindingId);
  if (!routeReady(storage) || !binding || binding.id !== claim.targetBindingId) return false;
  const row = storage.db.prepare("SELECT 1 AS ready FROM external_alert_deliveries WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=? AND lease_expires_at>?")
    .get(claim.deliveryId, claim.leaseToken, claim.leaseOwner, now);
  return Boolean(row);
}

function releaseIneligibleClaim(storage, claim, now) {
  return storage.transaction(function () {
    const changed = storage.db.prepare("UPDATE external_alert_deliveries SET state='RETRY_WAIT',next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='route_unavailable',updated_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=?")
      .run(now, now, claim.deliveryId, claim.leaseToken, claim.leaseOwner);
    return Number(changed.changes) === 1;
  });
}

export function completeExternalAlert(storage, claim, result, now = Date.now()) {
  if (!claim || !result || typeof result !== "object") throw new Error("external_alert_result_invalid");
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT * FROM external_alert_deliveries WHERE id=?").get(claim.deliveryId);
    if (!row || row.state !== "SENDING" || row.lease_token !== claim.leaseToken || row.lease_owner !== claim.leaseOwner) return { status: "stale" };
    if (Number(row.lease_expires_at) <= now) {
      recoverExpiredRows(storage, now);
      return { status: "expired" };
    }
    if (row.message_digest !== claim.messageDigest || row.message_private !== claim.message || sha256(Buffer.from(row.message_private, "utf8")) !== row.message_digest) {
      throw new Error("external_alert_integrity");
    }
    if (result.category === "accepted") {
      const receipt = result.safeReceipt;
      if (typeof result.providerReceiptRef !== "string" || result.providerReceiptRef.length < 1 || result.providerReceiptRef.length > 256 || !receipt || receipt.method !== "sendMessage" || receipt.renderedDigest !== row.message_digest) {
        throw new Error("external_alert_result_invalid");
      }
      storage.db.prepare("UPDATE external_alert_deliveries SET state='SENT',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,provider_receipt_ref=?,last_error_category=NULL,updated_at=?,terminal_at=? WHERE id=?")
        .run(result.providerReceiptRef, now, now, row.id);
      return { status: "sent" };
    }
    if (!["retryable", "rateLimited", "ambiguous", "routeBlocked", "permanent"].includes(result.category)) throw new Error("external_alert_result_invalid");
    if (result.category === "routeBlocked") {
      storage.db.prepare("UPDATE route_configurations SET state='DEGRADED',updated_at=? WHERE route='telegram'").run(now);
      storage.db.prepare("UPDATE external_alert_deliveries SET state='RETRY_WAIT',next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,updated_at=? WHERE id=?")
        .run(now, safeErrorCode(result), now, row.id);
      return { status: "retry_wait", nextAttemptAt: now };
    }
    const retryable = ["retryable", "rateLimited", "ambiguous"].includes(result.category);
    const due = retryable ? retryDueAt(Number(row.attempt_count), now, result.category === "rateLimited" ? result.retryAfterAt : null) : null;
    const state = retryable && due !== null ? "RETRY_WAIT" : "DEAD_LETTER";
    storage.db.prepare("UPDATE external_alert_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,ambiguous_acceptance=CASE WHEN ?='ambiguous' THEN 1 ELSE ambiguous_acceptance END,updated_at=?,terminal_at=? WHERE id=?")
      .run(state, due === null ? now : due, safeErrorCode(result), result.category, now, state === "DEAD_LETTER" ? now : null, row.id);
    return { status: state.toLowerCase(), nextAttemptAt: state === "RETRY_WAIT" ? due : null };
  });
}

export function nextExternalAlertDueAt(storage, targetBindingId = null) {
  const binding = activeBindingById(storage, targetBindingId);
  const row = binding ? storage.db.prepare(
    "SELECT MIN(due_at) AS due_at FROM (" +
    "SELECT d.next_attempt_at AS due_at FROM external_alert_deliveries d WHERE d.state IN ('QUEUED','RETRY_WAIT') AND " + READY_ROUTE +
    " UNION ALL SELECT d.lease_expires_at AS due_at FROM external_alert_deliveries d WHERE d.state='SENDING')"
  ).get() : storage.db.prepare("SELECT MIN(lease_expires_at) AS due_at FROM external_alert_deliveries WHERE state='SENDING'").get();
  return row && row.due_at !== null ? Number(row.due_at) : null;
}

async function sendWithDeadline(adapter, claim, controller, clock, timeoutMs) {
  let timer = null;
  const envelope = Object.freeze({
    payloadVersion: 1,
    recommendationId: null,
    route: "telegram",
    title: "Forwarded Harvester alert",
    plainText: claim.message,
    canonicalContentDigest: null,
    renderedDigest: claim.messageDigest,
    targetBindingId: claim.targetBindingId,
    omittedSections: []
  });
  const send = Promise.resolve().then(function () { return adapter.send(envelope, controller.signal); }).catch(function () {
    return { category: "ambiguous", safeError: { code: "external_alert_unknown" } };
  });
  const timeout = new Promise((resolve) => {
    timer = clock.setTimeout(function () {
      controller.abort();
      resolve({ category: "ambiguous", safeError: { code: "external_alert_timeout" } });
    }, timeoutMs);
  });
  const result = await Promise.race([send, timeout]);
  if (timer !== null) clock.clearTimeout(timer);
  return result;
}

export class ExternalAlertDispatcher {
  constructor(options) {
    this.storage = options.storage;
    this.adapter = options.adapter;
    this.resolveBinding = options.resolveBinding;
    if (typeof this.resolveBinding !== "function") throw new Error("external_alert_binding_resolver_invalid");
    this.workerId = options.workerId || createId("run");
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.attemptTimeoutMs = options.attemptTimeoutMs || DELIVERY_ATTEMPT_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs || 30_000;
    this.running = false;
    this.timer = null;
    this.generation = 0;
    this.pumpPromise = null;
    this.wakeAgain = false;
    this.activeAbort = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    recoverExpiredExternalAlertLeases(this.storage, this.clock.now());
    this.wake();
  }

  wake() {
    if (!this.running) return;
    this.generation += 1;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.pumpPromise) {
      this.wakeAgain = true;
      return;
    }
    this.clock.queueMicrotask(() => { void this.pump().catch(function () {}); });
  }

  async pump() {
    if (!this.running || this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = (async () => {
      do {
        this.wakeAgain = false;
        recoverExpiredExternalAlertLeases(this.storage, this.clock.now());
        let claim;
        let binding = this.resolveBinding();
        while (this.running && binding && (claim = claimExternalAlert(this.storage, this.workerId, this.clock.now(), binding.id))) {
          binding = this.resolveBinding();
          if (!binding || !externalAlertClaimReady(this.storage, claim, this.clock.now(), binding.id)) {
            releaseIneligibleClaim(this.storage, claim, this.clock.now());
            continue;
          }
          const controller = new AbortController();
          this.activeAbort = controller;
          let result;
          try { result = await sendWithDeadline(this.adapter, claim, controller, this.clock, this.attemptTimeoutMs); }
          finally { if (this.activeAbort === controller) this.activeAbort = null; }
          try { completeExternalAlert(this.storage, claim, result, this.clock.now()); }
          catch {
            try { completeExternalAlert(this.storage, claim, { category: "permanent", safeError: { code: "external_alert_result_invalid" } }, this.clock.now()); }
            catch {}
          }
          binding = this.resolveBinding();
        }
      } while (this.running && this.wakeAgain);
    })();
    try { await this.pumpPromise; }
    finally {
      this.pumpPromise = null;
      if (this.running) this.schedule();
    }
  }

  schedule() {
    if (!this.running) return;
    const binding = this.resolveBinding();
    const due = nextExternalAlertDueAt(this.storage, binding && binding.id);
    if (due === null) return;
    const generation = ++this.generation;
    const delay = Math.max(0, Math.min(2_147_483_647, due - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.running && generation === this.generation) this.wake();
    }, delay);
  }

  status() {
    return { running: this.running, active: Boolean(this.activeAbort) };
  }

  async stop() {
    if (!this.running) return { status: "stopped" };
    this.running = false;
    this.generation += 1;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.activeAbort) this.activeAbort.abort();
    if (!this.pumpPromise) return { status: "stopped" };
    let graceTimer = null;
    const settled = await Promise.race([
      this.pumpPromise.then(function () { return true; }, function () { return true; }),
      new Promise((resolve) => { graceTimer = this.clock.setTimeout(function () { resolve(false); }, this.stopGraceMs); })
    ]);
    if (settled && graceTimer !== null) this.clock.clearTimeout(graceTimer);
    return { status: settled ? "stopped" : "grace_expired" };
  }
}
