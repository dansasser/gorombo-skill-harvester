import { createId, sha256 } from "./ids.js";
import { retryDueAt } from "./outbox.js";
import { scanSafeContent } from "./content.js";
import { TELEGRAM_MESSAGE_LIMIT } from "./constants.js";

const TASK_ID = /^tsk_[0-9a-f]{32}$/u;
const RUN_ID = /^run_[0-9a-f]{32}$/u;
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function normalizeTaskText(text) {
  if (typeof text !== "string") throw new Error("task_text_invalid");
  const value = text.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 16_000) throw new Error("task_text_invalid");
  return value;
}

export function acceptTelegramTaskInTransaction(storage, input, now = Date.now()) {
  const requestText = normalizeTaskText(input.text);
  if (typeof input.updateIdentity !== "string" || !/^[0-9]{1,20}$/u.test(input.updateIdentity)) throw new Error("telegram_update_invalid");
  const prior = storage.db.prepare("SELECT task_id,state FROM telegram_updates WHERE update_identity=?").get(input.updateIdentity);
  if (prior) return { status: "duplicate", taskId: prior.task_id };
  const binding = storage.db.prepare("SELECT id FROM telegram_bindings WHERE id=? AND chat_type='private' AND state='ACTIVE'").get(input.bindingId);
  if (!binding) {
    storage.db.prepare("INSERT INTO telegram_updates(update_identity,binding_id,task_id,state,received_at) VALUES(?,?,NULL,'REJECTED',?)").run(input.updateIdentity, input.bindingId || null, now);
    return { status: "rejected", taskId: null };
  }
  const taskId = createId("tsk");
  storage.db.prepare("INSERT INTO tasks(id,source_route,source_message_identity,binding_id,request_text_private,state,accepted_at,updated_at) VALUES(?,'telegram',?,?,?,'QUEUED',?,?)")
    .run(taskId, input.updateIdentity, input.bindingId, requestText, now, now);
  storage.db.prepare("INSERT INTO telegram_updates(update_identity,binding_id,task_id,state,received_at) VALUES(?,?,?,'ACCEPTED',?)").run(input.updateIdentity, input.bindingId, taskId, now);
  return { status: "queued", taskId };
}

export function acceptTelegramTask(storage, input, now = Date.now()) {
  return storage.transaction(function () { return acceptTelegramTaskInTransaction(storage, input, now); });
}

export function claimTask(storage, now = Date.now()) {
  return storage.transaction(function () {
    const active = storage.db.prepare("SELECT id FROM tasks WHERE state='RUNNING' LIMIT 1").get();
    if (active) return null;
    const row = storage.db.prepare("SELECT * FROM tasks WHERE state='QUEUED' ORDER BY accepted_at,id LIMIT 1").get();
    if (!row) return null;
    const runNumber = Number(storage.db.prepare("SELECT COALESCE(MAX(run_number),0) AS n FROM task_runs WHERE task_id=?").get(row.id).n) + 1;
    const runId = createId("run");
    const changed = storage.db.prepare("UPDATE tasks SET state='RUNNING',updated_at=? WHERE id=? AND state='QUEUED'").run(now, row.id);
    if (Number(changed.changes) !== 1) return null;
    storage.db.prepare("INSERT INTO task_runs(id,task_id,run_number,state,started_at) VALUES(?,?,?,'RUNNING',?)").run(runId, row.id, runNumber, now);
    return { taskId: row.id, runId, runNumber, bindingId: row.binding_id, requestText: row.request_text_private };
  });
}

export function taskClaimReady(storage, claim, allowedUsers = null) {
  if (!claim || typeof claim.taskId !== "string" || !TASK_ID.test(claim.taskId) || typeof claim.runId !== "string" || !RUN_ID.test(claim.runId)) return false;
  if (allowedUsers !== null && !(allowedUsers instanceof Set)) return false;
  const row = storage.db.prepare(
    "SELECT b.user_identity FROM tasks t JOIN task_runs r ON r.task_id=t.id JOIN telegram_bindings b ON b.id=t.binding_id " +
    "WHERE t.id=? AND r.id=? AND t.binding_id=? AND t.state='RUNNING' AND r.state='RUNNING' AND b.chat_type='private' AND b.state='ACTIVE'"
  ).get(claim.taskId, claim.runId, claim.bindingId);
  return Boolean(row && (allowedUsers === null || allowedUsers.has(row.user_identity)));
}

export function markTaskClaimRecoveryRequired(storage, claim, code = "task_state_uncertain", now = Date.now()) {
  const safeCode = typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : "task_state_uncertain";
  return storage.transaction(function () {
    const task = storage.db.prepare("SELECT state FROM tasks WHERE id=?").get(claim.taskId);
    const run = storage.db.prepare("SELECT state FROM task_runs WHERE id=? AND task_id=?").get(claim.runId, claim.taskId);
    if (!task || !run || task.state !== "RUNNING" || run.state !== "RUNNING") return { status: "stale" };
    const safeResult = {
      ok: false,
      category: "recovery_required",
      safeMessage: "The task state requires local recovery.",
      code: safeCode
    };
    storage.db.prepare("UPDATE task_runs SET state='RECOVERY_REQUIRED',safe_result_json=?,completed_at=? WHERE id=? AND task_id=? AND state='RUNNING'")
      .run(JSON.stringify(safeResult), now, claim.runId, claim.taskId);
    storage.db.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='RUNNING'")
      .run(now, claim.taskId);
    return { status: "recovery_required" };
  });
}

function normalizeResultText(value) {
  if (typeof value !== "string") throw new Error("task_result_invalid");
  const text = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("task_result_invalid");
  return text;
}

function privateThreadId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 256 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("task_result_invalid");
  return value;
}

function shortenMessage(header, body, suffix) {
  const marker = "\n\n[Result shortened]";
  const fixed = Array.from(header + suffix);
  const bodyPoints = Array.from(body);
  if (fixed.length + bodyPoints.length <= TELEGRAM_MESSAGE_LIMIT) return header + body + suffix;
  const available = TELEGRAM_MESSAGE_LIMIT - fixed.length - Array.from(marker).length;
  return header + bodyPoints.slice(0, Math.max(0, available)).join("").trimEnd() + marker + suffix;
}

function safeTaskResult(result) {
  if (result.ok) {
    const resultText = normalizeResultText(result.resultText);
    if (!scanSafeContent(resultText).ok) {
      return {
        ok: true,
        withheld: true,
        safeMessage: "The result was withheld from Telegram because it may contain sensitive data or an unsafe path. Open the host task to review it."
      };
    }
    return { ok: true, resultText };
  }
  const category = typeof result.category === "string" ? result.category : "execution";
  const candidate = typeof result.safeMessage === "string" ? result.safeMessage.normalize("NFC").replace(/\r\n?/gu, "\n").trim() : "";
  const safeMessage = candidate && Buffer.byteLength(candidate, "utf8") <= 2000 && scanSafeContent(candidate).ok
    ? candidate
    : "The Codex task did not complete successfully.";
  return { ok: false, category, safeMessage };
}

function resultMessage(taskId, result) {
  const suffix = "\n\nTask ID: " + taskId;
  if (result.ok) {
    const body = result.withheld ? result.safeMessage : result.resultText;
    return shortenMessage("Task complete\n\n", body, suffix);
  }
  if (result.category === "authentication") return "Codex is not authenticated.\n\nAuthenticate Codex on the host, then send the task again." + suffix;
  if (result.category === "approval_required") return "Task is waiting for host approval.\n\nOpen the host task and resolve the request there." + suffix;
  if (result.category === "cancelled") return "Task cancelled." + suffix;
  return shortenMessage("Task failed.\n\n", result.safeMessage, suffix);
}

export function completeTask(storage, claim, result, now = Date.now()) {
  if (!result || typeof result !== "object" || (result.ok !== true && result.ok !== false)) throw new Error("task_result_invalid");
  const safeResult = safeTaskResult(result);
  const threadId = privateThreadId(result.threadId);
  const message = resultMessage(claim.taskId, safeResult);
  if (!scanSafeContent(message).ok || Array.from(message).length > TELEGRAM_MESSAGE_LIMIT) throw new Error("task_result_unsafe");
  return storage.transaction(function () {
    const task = storage.db.prepare("SELECT state FROM tasks WHERE id=?").get(claim.taskId);
    const run = storage.db.prepare("SELECT state FROM task_runs WHERE id=? AND task_id=?").get(claim.runId, claim.taskId);
    if (!task || !run || task.state !== "RUNNING" || run.state !== "RUNNING") return { status: "stale" };
    let state;
    if (result.ok) state = "SUCCEEDED";
    else if (result.category === "cancelled") state = "CANCELLED";
    else if (result.category === "approval_required") state = "WAITING_APPROVAL";
    else state = "FAILED";
    storage.db.prepare("UPDATE task_runs SET state=?,thread_id_private=?,safe_result_json=?,completed_at=? WHERE id=? AND state='RUNNING'")
      .run(state, threadId, JSON.stringify(safeResult), now, claim.runId);
    storage.db.prepare("UPDATE tasks SET state=?,updated_at=?,terminal_at=? WHERE id=? AND state='RUNNING'").run(state, now, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(state) ? now : null, claim.taskId);
    const deliveryId = createId("out");
    storage.db.prepare("INSERT INTO task_result_deliveries(id,task_id,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,'QUEUED',?,?,?,?,?)")
      .run(deliveryId, claim.taskId, message, sha256(Buffer.from(message, "utf8")), now, now, now);
    return { status: state.toLowerCase(), deliveryId };
  });
}

export function recoverUncertainTasks(storage, now = Date.now()) {
  return storage.transaction(function () {
    const rows = storage.db.prepare("SELECT id FROM tasks WHERE state='RUNNING'").all();
    for (const row of rows) {
      storage.db.prepare("UPDATE tasks SET state='RECOVERY_REQUIRED',updated_at=? WHERE id=? AND state='RUNNING'").run(now, row.id);
      storage.db.prepare("UPDATE task_runs SET state='RECOVERY_REQUIRED',completed_at=? WHERE task_id=? AND state='RUNNING'").run(now, row.id);
    }
    return rows.length;
  });
}

export function cancelTaskById(storage, taskId, now = Date.now()) {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw new Error("task_id_invalid");
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT id,state FROM tasks WHERE id=? AND state IN ('QUEUED','RUNNING')").get(taskId);
    if (!row) return null;
    if (row.state === "RUNNING") return { taskId: row.id, state: "abort_required" };
    const changed = storage.db.prepare("UPDATE tasks SET state='CANCELLED',updated_at=?,terminal_at=? WHERE id=? AND state='QUEUED'").run(now, now, row.id);
    if (Number(changed.changes) !== 1) return null;
    const message = "Task cancelled.\n\nTask ID: " + row.id;
    const deliveryId = createId("out");
    storage.db.prepare("INSERT INTO task_result_deliveries(id,task_id,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,'QUEUED',?,?,?,?,?)")
      .run(deliveryId, row.id, message, sha256(Buffer.from(message, "utf8")), now, now, now);
    return { taskId: row.id, state: "cancelled", deliveryId };
  });
}

export function cancelTaskInTransaction(storage, bindingId, now = Date.now()) {
  const row = storage.db.prepare("SELECT id,state FROM tasks WHERE binding_id=? AND state IN ('QUEUED','RUNNING') ORDER BY accepted_at LIMIT 1").get(bindingId);
  if (!row) return null;
  if (row.state === "QUEUED") {
    const changed = storage.db.prepare("UPDATE tasks SET state='CANCELLED',updated_at=?,terminal_at=? WHERE id=? AND state='QUEUED'").run(now, now, row.id);
    if (Number(changed.changes) !== 1) return null;
    const message = "Task cancelled.\n\nTask ID: " + row.id;
    const deliveryId = createId("out");
    storage.db.prepare("INSERT INTO task_result_deliveries(id,task_id,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,'QUEUED',?,?,?,?,?)")
      .run(deliveryId, row.id, message, sha256(Buffer.from(message, "utf8")), now, now, now);
    return { taskId: row.id, state: "cancelled", deliveryId };
  }
  return { taskId: row.id, state: "abort_required" };
}

export function cancelTask(storage, bindingId, now = Date.now()) {
  return storage.transaction(function () { return cancelTaskInTransaction(storage, bindingId, now); });
}

export function recoverExpiredTaskResultLeases(storage, now = Date.now()) {
  return storage.transaction(function () {
    const rows = storage.db.prepare("SELECT id,attempt_count,lease_token,lease_owner FROM task_result_deliveries WHERE state='SENDING' AND lease_expires_at<=? ORDER BY lease_expires_at,id").all(now);
    for (const row of rows) {
      const due = retryDueAt(Number(row.attempt_count), now);
      const state = due === null ? "DEAD_LETTER" : "RETRY_WAIT";
      storage.db.prepare("UPDATE task_result_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='lease_expired',ambiguous_acceptance=1,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=? AND lease_expires_at<=?")
        .run(state, due === null ? now : due, now, state === "DEAD_LETTER" ? now : null, row.id, row.lease_token, row.lease_owner, now);
    }
    return rows.length;
  });
}

export function claimTaskResult(storage, workerId, now = Date.now()) {
  if (typeof workerId !== "string" || !WORKER_ID.test(workerId)) throw new Error("task_result_worker_invalid");
  return storage.transaction(function () {
    const expired = storage.db.prepare("SELECT id,attempt_count,lease_token,lease_owner FROM task_result_deliveries WHERE state='SENDING' AND lease_expires_at<=? ORDER BY lease_expires_at,id").all(now);
    for (const prior of expired) {
      const due = retryDueAt(Number(prior.attempt_count), now);
      const state = due === null ? "DEAD_LETTER" : "RETRY_WAIT";
      storage.db.prepare("UPDATE task_result_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='lease_expired',ambiguous_acceptance=1,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=? AND lease_expires_at<=?")
        .run(state, due === null ? now : due, now, state === "DEAD_LETTER" ? now : null, prior.id, prior.lease_token, prior.lease_owner, now);
    }
    const row = storage.db.prepare(
      "SELECT d.*,b.chat_identity FROM task_result_deliveries d JOIN tasks t ON t.id=d.task_id " +
      "JOIN telegram_bindings b ON b.id=t.binding_id JOIN route_configurations q ON q.route='telegram' " +
      "WHERE d.state IN ('QUEUED','RETRY_WAIT') AND d.next_attempt_at<=? AND b.chat_type='private' AND b.state='ACTIVE' AND q.selected=1 AND q.state='READY' " +
      "ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1"
    ).get(now);
    if (!row) return null;
    const token = createId("run");
    const attemptNumber = Number(row.attempt_count) + 1;
    const leaseExpiresAt = now + 90_000;
    const changed = storage.db.prepare("UPDATE task_result_deliveries SET state='SENDING',attempt_count=?,lease_token=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','RETRY_WAIT')")
      .run(attemptNumber, token, workerId, leaseExpiresAt, now, row.id);
    if (Number(changed.changes) !== 1) return null;
    return {
      deliveryId: row.id,
      taskId: row.task_id,
      message: row.message_private,
      messageDigest: row.message_digest,
      chatIdentity: row.chat_identity,
      attemptNumber,
      leaseToken: token,
      leaseOwner: workerId,
      leaseExpiresAt
    };
  });
}

export function taskResultClaimReady(storage, claim, now = Date.now()) {
  if (!claim) return false;
  const row = storage.db.prepare(
    "SELECT d.message_private,d.message_digest FROM task_result_deliveries d JOIN tasks t ON t.id=d.task_id " +
    "JOIN telegram_bindings b ON b.id=t.binding_id JOIN route_configurations q ON q.route='telegram' " +
    "WHERE d.id=? AND d.state='SENDING' AND d.lease_token=? AND d.lease_owner=? AND d.lease_expires_at>? " +
    "AND b.chat_type='private' AND b.state='ACTIVE' AND q.selected=1 AND q.state='READY'"
  ).get(claim.deliveryId, claim.leaseToken, claim.leaseOwner, now);
  return Boolean(row && row.message_private === claim.message && row.message_digest === claim.messageDigest && sha256(Buffer.from(row.message_private, "utf8")) === row.message_digest);
}

export function deferTaskResultClaim(storage, claim, code = "route_unavailable", now = Date.now()) {
  const safeCode = typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : "route_unavailable";
  return storage.transaction(function () {
    const changed = storage.db.prepare("UPDATE task_result_deliveries SET state='RETRY_WAIT',next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,updated_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_owner=?")
      .run(now, safeCode, now, claim.deliveryId, claim.leaseToken, claim.leaseOwner);
    return Number(changed.changes) === 1;
  });
}

export function completeTaskResult(storage, claim, result, now = Date.now()) {
  if (!claim || !result || typeof result !== "object") throw new Error("task_result_delivery_invalid");
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT * FROM task_result_deliveries WHERE id=?").get(claim.deliveryId);
    if (!row || row.state !== "SENDING" || row.lease_token !== claim.leaseToken || row.lease_owner !== claim.leaseOwner || Number(row.lease_expires_at) <= now) return { status: "stale" };
    if (row.message_private !== claim.message || row.message_digest !== claim.messageDigest || sha256(Buffer.from(row.message_private, "utf8")) !== row.message_digest) throw new Error("task_result_delivery_integrity");
    if (result.category === "accepted") {
      const receipt = result.safeReceipt;
      if (typeof result.providerReceiptRef !== "string" || !/^[0-9]{1,20}$/u.test(result.providerReceiptRef) || !receipt || receipt.method !== "sendMessage" || receipt.messageDigest !== row.message_digest) throw new Error("task_result_delivery_invalid");
      storage.db.prepare("UPDATE task_result_deliveries SET state='SENT',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,provider_receipt_ref=?,last_error_category=NULL,updated_at=?,terminal_at=? WHERE id=?")
        .run(result.providerReceiptRef, now, now, row.id);
      return { status: "sent" };
    }
    if (!["retryable","rateLimited","ambiguous","routeBlocked","permanent"].includes(result.category)) throw new Error("task_result_delivery_invalid");
    const retryable = ["retryable","rateLimited","ambiguous"].includes(result.category);
    const due = retryable ? retryDueAt(Number(row.attempt_count), now, result.category === "rateLimited" ? result.retryAfterAt : null) : null;
    const state = retryable && due !== null ? "RETRY_WAIT" : "DEAD_LETTER";
    const candidate = result.safeError && result.safeError.code;
    const safeCode = typeof candidate === "string" && SAFE_ERROR_CODE.test(candidate) ? candidate : "task_result_delivery_failed";
    storage.db.prepare("UPDATE task_result_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,ambiguous_acceptance=CASE WHEN ?='ambiguous' THEN 1 ELSE ambiguous_acceptance END,updated_at=?,terminal_at=? WHERE id=?")
      .run(state, due === null ? now : due, safeCode, result.category, now, state === "DEAD_LETTER" ? now : null, row.id);
    return { status: state.toLowerCase(), nextAttemptAt: state === "RETRY_WAIT" ? due : null };
  });
}

export function nextTaskResultDueAt(storage) {
  const queued = storage.db.prepare(
    "SELECT MIN(d.next_attempt_at) AS due FROM task_result_deliveries d JOIN tasks t ON t.id=d.task_id " +
    "JOIN telegram_bindings b ON b.id=t.binding_id JOIN route_configurations q ON q.route='telegram' " +
    "WHERE d.state IN ('QUEUED','RETRY_WAIT') AND b.chat_type='private' AND b.state='ACTIVE' AND q.selected=1 AND q.state='READY'"
  ).get();
  const lease = storage.db.prepare("SELECT MIN(lease_expires_at) AS due FROM task_result_deliveries WHERE state='SENDING'").get();
  const values = [queued && queued.due, lease && lease.due].filter(function (value) { return value !== null && value !== undefined; }).map(Number);
  return values.length ? Math.min(...values) : null;
}
