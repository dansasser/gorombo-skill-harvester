import { DELIVERY_ATTEMPT_TIMEOUT_MS, DELIVERY_RETRY_DELAYS_MS, MAX_DELIVERY_ATTEMPTS, TELEGRAM_MESSAGE_LIMIT } from "./constants.js";
import { scanSafeContent } from "./content.js";
import { createId, sha256 } from "./ids.js";
import { normalizeTelegramIdentity } from "./telegram-identity.js";

const PURPOSES = new Set(["PAIRING", "STATUS", "CANCEL", "HELP", "REJECTION", "CONFIRMATION"]);
const SOURCE_IDENTITY = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.:-]{1,256}$/u;
const BINDING_ID = /^bnd_[0-9a-f]{32}$/u;
const REPLY_ROUTE_ELIGIBLE = "EXISTS(SELECT 1 FROM route_configurations q WHERE q.route='telegram' AND q.selected=1 AND q.state IN ('CONFIGURED','VERIFYING','READY'))";
const REPLY_ELIGIBLE = REPLY_ROUTE_ELIGIBLE + " AND (d.purpose IN ('PAIRING','CONFIRMATION','REJECTION') OR EXISTS(SELECT 1 FROM telegram_bindings b WHERE b.id=d.binding_id AND b.chat_identity=d.chat_identity_private AND b.chat_type='private' AND b.state='ACTIVE'))";

function normalizeMessage(value) {
  if (typeof value !== "string") throw new Error("telegram_reply_invalid");
  const message = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (message.length === 0 || Array.from(message).length > TELEGRAM_MESSAGE_LIMIT || !scanSafeContent(message).ok) throw new Error("telegram_reply_invalid");
  return message;
}

function retryDueAt(attemptNumber, now, retryAfterAt = null) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return null;
  const normal = now + DELIVERY_RETRY_DELAYS_MS[attemptNumber - 1];
  if (retryAfterAt === null) return normal;
  if (!Number.isSafeInteger(retryAfterAt) || retryAfterAt <= now || retryAfterAt > now + 7 * 24 * 60 * 60 * 1000) throw new Error("telegram_reply_result_invalid");
  return Math.max(normal, retryAfterAt);
}

function safeErrorCode(result) {
  const value = result && result.safeError && result.safeError.code;
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "telegram_reply_failed";
}

export function queueTelegramReplyInTransaction(storage, input, now = Date.now()) {
  if (!input || !PURPOSES.has(input.purpose) || typeof input.sourceIdentity !== "string" || !SOURCE_IDENTITY.test(input.sourceIdentity)) throw new Error("telegram_reply_invalid");
  const chatIdentity = normalizeTelegramIdentity(input.chatIdentity);
  const bindingId = input.bindingId === undefined || input.bindingId === null ? null : input.bindingId;
  if (bindingId !== null) {
    if (typeof bindingId !== "string" || !BINDING_ID.test(bindingId)) throw new Error("telegram_reply_invalid");
    const binding = storage.db.prepare("SELECT chat_identity FROM telegram_bindings WHERE id=? AND chat_type='private'").get(bindingId);
    if (!binding || binding.chat_identity !== chatIdentity) throw new Error("telegram_reply_invalid");
  }
  const message = normalizeMessage(input.message);
  const digest = sha256(Buffer.from(message, "utf8"));
  const existing = storage.db.prepare("SELECT id,message_digest,message_private FROM telegram_reply_deliveries WHERE source_identity=? AND purpose=?").get(input.sourceIdentity, input.purpose);
  if (existing) {
    if (existing.message_digest !== digest || existing.message_private !== message) throw new Error("telegram_reply_conflict");
    return { status: "duplicate", deliveryId: existing.id };
  }
  const id = createId("out");
  storage.db.prepare("INSERT INTO telegram_reply_deliveries(id,source_identity,purpose,binding_id,chat_identity_private,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,?,?,?,?)")
    .run(id, input.sourceIdentity, input.purpose, bindingId, chatIdentity, message, digest, now, now, now);
  return { status: "queued", deliveryId: id };
}

export function queueTelegramReply(storage, input, now = Date.now()) {
  return storage.transaction(function () { return queueTelegramReplyInTransaction(storage, input, now); });
}

function recoverExpiredRows(storage, now) {
  const rows = storage.db.prepare("SELECT id,attempt_count,lease_token FROM telegram_reply_deliveries WHERE state='SENDING' AND lease_expires_at<=? ORDER BY lease_expires_at,id").all(now);
  for (const row of rows) {
    const due = retryDueAt(Number(row.attempt_count), now);
    const state = due === null ? "DEAD_LETTER" : "RETRY_WAIT";
    storage.db.prepare("UPDATE telegram_reply_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='lease_expired',ambiguous_acceptance=1,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_expires_at<=?")
      .run(state, due === null ? now : due, now, state === "DEAD_LETTER" ? now : null, row.id, row.lease_token, now);
  }
  return rows.length;
}

export function recoverExpiredTelegramReplyLeases(storage, now = Date.now()) {
  return storage.transaction(function () { return recoverExpiredRows(storage, now); });
}

export function claimTelegramReply(storage, workerId, now = Date.now()) {
  if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128) throw new Error("telegram_reply_worker_invalid");
  return storage.transaction(function () {
    recoverExpiredRows(storage, now);
    const row = storage.db.prepare("SELECT d.* FROM telegram_reply_deliveries d WHERE d.state IN ('QUEUED','RETRY_WAIT') AND d.next_attempt_at<=? AND " + REPLY_ELIGIBLE + " ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1").get(now);
    if (!row) return null;
    const token = createId("run");
    const attemptNumber = Number(row.attempt_count) + 1;
    const changed = storage.db.prepare("UPDATE telegram_reply_deliveries SET state='SENDING',attempt_count=?,lease_token=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','RETRY_WAIT')")
      .run(attemptNumber, token, workerId, now + 90_000, now, row.id);
    if (Number(changed.changes) !== 1) return null;
    return {
      deliveryId: row.id,
      purpose: row.purpose,
      bindingId: row.binding_id,
      chatIdentity: row.chat_identity_private,
      message: row.message_private,
      messageDigest: row.message_digest,
      attemptNumber,
      leaseToken: token,
      leaseOwner: workerId,
      leaseExpiresAt: now + 90_000
    };
  });
}

export function telegramReplyClaimReady(storage, claim, now = Date.now()) {
  if (!claim) return false;
  const row = storage.db.prepare("SELECT 1 AS ready FROM telegram_reply_deliveries d WHERE d.id=? AND d.state='SENDING' AND d.lease_token=? AND d.lease_owner=? AND d.lease_expires_at>? AND " + REPLY_ELIGIBLE)
    .get(claim.deliveryId, claim.leaseToken, claim.leaseOwner, now);
  return Boolean(row);
}

function releaseIneligibleClaim(storage, claim, now) {
  return storage.transaction(function () {
    const changed = storage.db.prepare("UPDATE telegram_reply_deliveries SET state='RETRY_WAIT',next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='route_unavailable',updated_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=?")
      .run(now, now, claim.deliveryId, claim.leaseToken, claim.leaseOwner);
    return Number(changed.changes) === 1;
  });
}

export function completeTelegramReply(storage, claim, result, now = Date.now()) {
  if (!claim || !result || typeof result !== "object") throw new Error("telegram_reply_result_invalid");
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT * FROM telegram_reply_deliveries WHERE id=?").get(claim.deliveryId);
    if (!row || row.state !== "SENDING" || row.lease_token !== claim.leaseToken || row.lease_owner !== claim.leaseOwner || Number(row.lease_expires_at) <= now) return { status: "stale" };
    if (row.message_digest !== claim.messageDigest || row.message_private !== claim.message) throw new Error("telegram_reply_integrity");
    if (result.category === "accepted") {
      const receipt = result.safeReceipt;
      if (typeof result.providerReceiptRef !== "string" || !/^[0-9]{1,20}$/u.test(result.providerReceiptRef) || !receipt || receipt.method !== "sendMessage" || receipt.messageDigest !== row.message_digest) throw new Error("telegram_reply_result_invalid");
      storage.db.prepare("UPDATE telegram_reply_deliveries SET state='SENT',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,provider_receipt_ref=?,last_error_category=NULL,updated_at=?,terminal_at=? WHERE id=?")
        .run(result.providerReceiptRef, now, now, row.id);
      return { status: "sent" };
    }
    if (!["retryable", "rateLimited", "ambiguous", "routeBlocked", "permanent"].includes(result.category)) throw new Error("telegram_reply_result_invalid");
    const retryable = ["retryable", "rateLimited", "ambiguous"].includes(result.category);
    const due = retryable ? retryDueAt(Number(row.attempt_count), now, result.category === "rateLimited" ? result.retryAfterAt : null) : null;
    const state = retryable && due !== null ? "RETRY_WAIT" : "DEAD_LETTER";
    storage.db.prepare("UPDATE telegram_reply_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,ambiguous_acceptance=CASE WHEN ?='ambiguous' THEN 1 ELSE ambiguous_acceptance END,updated_at=?,terminal_at=? WHERE id=?")
      .run(state, due === null ? now : due, safeErrorCode(result), result.category, now, state === "DEAD_LETTER" ? now : null, row.id);
    return { status: state.toLowerCase(), nextAttemptAt: state === "RETRY_WAIT" ? due : null };
  });
}

export function nextTelegramReplyDueAt(storage) {
  const row = storage.db.prepare(
    "SELECT MIN(due_at) AS due_at FROM (" +
    "SELECT d.next_attempt_at AS due_at FROM telegram_reply_deliveries d WHERE d.state IN ('QUEUED','RETRY_WAIT') AND " + REPLY_ELIGIBLE + " " +
    "UNION ALL SELECT d.lease_expires_at AS due_at FROM telegram_reply_deliveries d WHERE d.state='SENDING')"
  ).get();
  return row && row.due_at !== null ? Number(row.due_at) : null;
}

async function sendWithDeadline(client, claim, controller, clock, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = clock.setTimeout(() => {
      controller.abort();
      resolve({ category: "ambiguous", safeError: { code: "telegram_reply_timeout" } });
    }, timeoutMs);
  });
  const send = Promise.resolve().then(function () {
    return client.sendText(claim.chatIdentity, claim.message, controller.signal);
  }).catch(function () {
    return { category: "ambiguous", safeError: { code: "telegram_reply_unknown" } };
  });
  const result = await Promise.race([send, timeout]);
  if (timer !== null) clock.clearTimeout(timer);
  if (result && result.category === "accepted") {
    result.safeReceipt = { ...(result.safeReceipt || {}), messageDigest: claim.messageDigest };
  }
  return result;
}

export class TelegramReplyDispatcher {
  constructor(options) {
    this.storage = options.storage;
    this.client = options.client;
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
    recoverExpiredTelegramReplyLeases(this.storage, this.clock.now());
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
        recoverExpiredTelegramReplyLeases(this.storage, this.clock.now());
        let claim;
        while (this.running && (claim = claimTelegramReply(this.storage, this.workerId, this.clock.now()))) {
          if (!telegramReplyClaimReady(this.storage, claim, this.clock.now())) {
            releaseIneligibleClaim(this.storage, claim, this.clock.now());
            continue;
          }
          const controller = new AbortController();
          this.activeAbort = controller;
          let result;
          try { result = await sendWithDeadline(this.client, claim, controller, this.clock, this.attemptTimeoutMs); }
          finally { if (this.activeAbort === controller) this.activeAbort = null; }
          try { completeTelegramReply(this.storage, claim, result, this.clock.now()); }
          catch {
            try { completeTelegramReply(this.storage, claim, { category: "permanent", safeError: { code: "telegram_reply_result_invalid" } }, this.clock.now()); }
            catch {}
          }
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
    const due = nextTelegramReplyDueAt(this.storage);
    if (due === null) return;
    const generation = ++this.generation;
    const delay = Math.max(0, Math.min(2_147_483_647, due - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.running && generation === this.generation) this.wake();
    }, delay);
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
