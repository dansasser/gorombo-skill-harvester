import path from "node:path";
import { createId } from "./ids.js";
import { scanSafeContent } from "./content.js";
import { AppServerError } from "./app-server.js";
import { completeOnboardingIfReadyInTransaction } from "./onboarding.js";

const MAX_SESSION_NAME_SCALARS = 120;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export function normalizeSessionName(value) {
  if (typeof value !== "string") throw new Error("session_name_invalid");
  const name = value.normalize("NFC").trim();
  if (name.length === 0 || Array.from(name).length > MAX_SESSION_NAME_SCALARS || /[\u0000-\u001f\u007f]/u.test(name) || !scanSafeContent(name).ok) throw new Error("session_name_invalid");
  return name;
}

function visibleThread(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256) throw new Error("session_contract_invalid");
  const name = value.name === null || value.name === undefined ? null : normalizeSessionName(value.name);
  const status = typeof value.status === "string"
    ? value.status.slice(0, 64)
    : value.status && typeof value.status.type === "string"
      ? value.status.type.slice(0, 64)
      : "unknown";
  return { id: value.id, name, status };
}

export async function listSessions(client, options = {}) {
  const pages = options.maxPages || MAX_PAGES;
  const pageSize = options.pageSize || PAGE_SIZE;
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) throw new Error("session_pagination_invalid");
  const threads = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < pages; page += 1) {
    const params = cursor === null ? { limit: pageSize } : { limit: pageSize, cursor };
    const result = await client.request("thread/list", params);
    if (!result || typeof result !== "object" || !Array.isArray(result.data)) throw new Error("session_contract_invalid");
    for (const item of result.data) threads.push(visibleThread(item));
    const next = result.nextCursor;
    if (next === null || next === undefined) return threads;
    if (typeof next !== "string" || next.length < 1 || next.length > 512 || seen.has(next)) throw new Error("session_pagination_invalid");
    seen.add(next);
    cursor = next;
  }
  throw new Error("session_pagination_limit");
}

function persistBinding(storage, thread, name, now) {
  return storage.transaction(function () {
    const prior = storage.db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM session_routes").get();
    const revision = Number(prior.revision) + 1;
    storage.db.prepare("DELETE FROM session_routes").run();
    const id = createId("ses");
    storage.db.prepare("INSERT INTO session_routes(id,display_name,internal_thread_id,state,revision,selected_at,last_verified_at) VALUES(?,?,?,'SELECTED',?,?,?)")
      .run(id, name, thread.id, revision, now, now);
    storage.upsertRoute("session", true, "DEGRADED", { displayName: name }, now);
    return { id, displayName: name, state: "SELECTED", revision };
  });
}

export async function selectSession(storage, client, visibleName, now = Date.now()) {
  const name = normalizeSessionName(visibleName);
  const matches = (await listSessions(client)).filter(function (item) { return item.name === name; });
  if (matches.length === 0) throw new Error("session_missing");
  if (matches.length > 1) throw new Error("session_name_ambiguous");
  return persistBinding(storage, matches[0], name, now);
}

export async function createSession(storage, client, visibleName, workingDirectory, now = Date.now()) {
  const name = normalizeSessionName(visibleName);
  if (typeof workingDirectory !== "string" || !path.isAbsolute(workingDirectory)) throw new Error("session_cwd_invalid");
  const result = await client.request("thread/start", { cwd: workingDirectory, ephemeral: false });
  const thread = visibleThread(result && result.thread ? result.thread : result);
  await client.request("thread/name/set", { threadId: thread.id, name });
  const matches = (await listSessions(client)).filter(function (item) { return item.name === name; });
  if (matches.length !== 1 || matches[0].id !== thread.id) throw new Error(matches.length > 1 ? "session_name_ambiguous" : "session_name_verification_failed");
  return persistBinding(storage, matches[0], name, now);
}

function selectedRow(storage) {
  const rows = storage.db.prepare("SELECT * FROM session_routes ORDER BY revision DESC LIMIT 2").all();
  if (rows.length > 1) throw new Error("session_binding_ambiguous");
  return rows[0] || null;
}

function updateBindingState(storage, row, state, routeState, now) {
  storage.transaction(function () {
    storage.db.prepare("UPDATE session_routes SET state=?,last_verified_at=? WHERE id=?").run(state, now, row.id);
    storage.db.prepare("UPDATE route_configurations SET state=?,updated_at=? WHERE route='session'").run(routeState, now);
  });
}

function busyStatus(value) {
  const status = String(value || "").toLowerCase();
  return status.includes("active") || status.includes("progress") || status.includes("running") || status.includes("busy");
}

export async function verifySessionRoute(storage, client, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  let row;
  try { row = selectedRow(storage); }
  catch { return { ok: false, result: { category: "routeBlocked", safeError: { code: "session_reselection_required" } } }; }
  if (!row) return { ok: false, result: { category: "routeBlocked", safeError: { code: "session_unconfigured" } } };
  let threads;
  try { threads = await listSessions(client); }
  catch (error) {
    const result = classifySessionError(error, false);
    updateBindingState(storage, row, "INACCESSIBLE", "DEGRADED", now);
    return { ok: false, result };
  }
  const byId = threads.find(function (item) { return item.id === row.internal_thread_id; });
  if (!byId) {
    updateBindingState(storage, row, "RESELECTION_REQUIRED", "DEGRADED", now);
    return { ok: false, result: { category: "routeBlocked", safeError: { code: "session_missing" } } };
  }
  const exactMatches = threads.filter(function (item) { return item.name === row.display_name; });
  if (byId.name !== row.display_name || exactMatches.length !== 1 || exactMatches[0].id !== row.internal_thread_id) {
    updateBindingState(storage, row, "RESELECTION_REQUIRED", "DEGRADED", now);
    return { ok: false, result: { category: "routeBlocked", safeError: { code: "session_reselection_required" } } };
  }
  let state = row.state;
  if (busyStatus(byId.status)) {
    state = "BUSY";
    updateBindingState(storage, row, "BUSY", "READY", now);
  } else if (row.state !== "SELECTED") {
    state = "READY";
    updateBindingState(storage, row, "READY", "READY", now);
  } else if (options.allowSelected) updateBindingState(storage, row, "SELECTED", "DEGRADED", now);
  return { ok: true, binding: { id: row.id, displayName: row.display_name, internalThreadId: row.internal_thread_id, state }, threadStatus: byId.status };
}

function turnIdentifier(result, expectedThreadId) {
  const turn = result && result.turn ? result.turn : result;
  if (!turn || typeof turn !== "object" || typeof turn.id !== "string" || turn.id.length < 1 || turn.id.length > 256) throw new Error("session_contract_invalid");
  const observedThread = typeof turn.threadId === "string" ? turn.threadId : typeof result.threadId === "string" ? result.threadId : expectedThreadId;
  if (observedThread !== expectedThreadId) throw new Error("session_contract_invalid");
  return turn.id;
}

function matchingTurn(notification, threadId, turnId) {
  if (!notification || notification.method !== "turn/completed") return false;
  const params = notification.params || {};
  const turn = params.turn || {};
  return params.threadId === threadId && turn.id === turnId;
}

function completedStatus(notification) {
  const turn = notification && notification.params && notification.params.turn;
  return turn && typeof turn.status === "string" ? turn.status : null;
}

function classifySessionError(error, afterWrite) {
  const message = String(error && (error.rpcMessage || error.message) || "").toLowerCase();
  if (message.includes("busy") || message.includes("active turn")) return { category: "retryable", safeError: { code: "session_busy" } };
  if (message.includes("not found") || message.includes("missing")) return { category: "routeBlocked", safeError: { code: "session_missing" } };
  if (message.includes("auth") || message.includes("permission") || message.includes("denied")) return { category: "routeBlocked", safeError: { code: "session_auth" } };
  if (error instanceof AppServerError && ["request_timeout", "notification_timeout", "request_aborted", "connection_closed"].includes(error.code) && (afterWrite || error.requestWritten)) {
    return { category: "ambiguous", safeError: { code: "completion_unknown" } };
  }
  if (error instanceof AppServerError && error.code === "connection_unavailable" && !error.requestWritten) return { category: "retryable", safeError: { code: "connection_unavailable" } };
  if (error instanceof AppServerError && error.code === "rpc_error") return { category: "permanent", safeError: { code: "adapter_contract_invalid" } };
  return { category: "permanent", safeError: { code: "adapter_contract_invalid" } };
}

export function createSessionAdapter(options) {
  const storage = options.storage;
  const client = options.client;
  const allowSelected = Boolean(options.allowSelected);
  const timeoutMs = options.timeoutMs || 30_000;
  const now = options.now || Date.now;
  return {
    async send(envelope, signal) {
      const verified = await verifySessionRoute(storage, client, { allowSelected, now: now() });
      if (!verified.ok) return verified.result;
      if (verified.binding.state === "BUSY") return { category: "retryable", safeError: { code: "session_busy" } };
      if (verified.binding.state !== "READY" && !allowSelected) return { category: "routeBlocked", safeError: { code: "session_not_tested" } };
      const row = selectedRow(storage);
      updateBindingState(storage, row, "BUSY", "VERIFYING", now());
      let turnId;
      try {
        const result = await client.request("turn/start", {
          threadId: verified.binding.internalThreadId,
          input: [{ type: "text", text: envelope.plainText }]
        }, { signal, timeoutMs });
        turnId = turnIdentifier(result, verified.binding.internalThreadId);
      } catch (error) {
        const mapped = classifySessionError(error, Boolean(error && error.requestWritten));
        updateBindingState(storage, row, mapped.safeError.code === "session_missing" ? "RESELECTION_REQUIRED" : mapped.safeError.code === "session_auth" ? "INACCESSIBLE" : mapped.safeError.code === "session_busy" ? "BUSY" : "READY", mapped.category === "routeBlocked" ? "DEGRADED" : "READY", now());
        return mapped;
      }
      try {
        const notification = await client.waitForNotification(function (candidate) {
          return matchingTurn(candidate, verified.binding.internalThreadId, turnId);
        }, { signal, timeoutMs });
        if (completedStatus(notification) !== "completed") {
          updateBindingState(storage, row, "READY", "READY", now());
          return { category: "permanent", safeError: { code: "session_turn_failed" } };
        }
      } catch (error) {
        updateBindingState(storage, row, "READY", "READY", now());
        return classifySessionError(error, true);
      }
      updateBindingState(storage, row, "READY", "READY", now());
      return {
        category: "accepted",
        providerReceiptRef: turnId,
        safeReceipt: { method: "turn/start", renderedDigest: envelope.renderedDigest }
      };
    }
  };
}

export async function testSessionRoute(storage, client, message, renderedDigest, options = {}) {
  if (typeof message !== "string" || !message.startsWith("Gorombo Skill Harvester") || Buffer.byteLength(message, "utf8") > 12_000 || !scanSafeContent(message).ok || !/^[a-f0-9]{64}$/u.test(renderedDigest)) throw new Error("session_test_invalid");
  const adapter = createSessionAdapter({ storage, client, allowSelected: true, timeoutMs: options.timeoutMs, now: options.now });
  const result = await adapter.send({ plainText: message, renderedDigest }, options.signal);
  if (result.category !== "accepted") return result;
  const now = options.now ? options.now() : Date.now();
  return storage.transaction(function () {
    const row = selectedRow(storage);
    storage.db.prepare("UPDATE session_routes SET state='READY',last_verified_at=? WHERE id=?").run(now, row.id);
    storage.db.prepare("UPDATE route_configurations SET state='READY',updated_at=? WHERE route='session'").run(now);
    const route = storage.getRoute("session");
    const prior = storage.db.prepare("SELECT COALESCE(MAX(test_generation),-1) AS generation FROM route_test_receipts WHERE route='session' AND configuration_revision=?").get(route.revision);
    const generation = Number(prior.generation) + 1;
    storage.db.prepare("INSERT INTO route_test_receipts(id,route,configuration_revision,test_generation,provider_receipt_ref,accepted_at,safe_receipt_json) VALUES(?,'session',?,?,?,?,?)")
      .run(createId("rcp"), route.revision, generation, result.providerReceiptRef, now, JSON.stringify(result.safeReceipt));
    completeOnboardingIfReadyInTransaction(storage, now);
    return result;
  });
}

export function clearSessionRoute(storage, now = Date.now()) {
  return storage.transaction(function () {
    storage.db.prepare("DELETE FROM session_routes").run();
    storage.upsertRoute("session", false, "DISABLED", {}, now);
    return { status: "cleared" };
  });
}

export function sessionStatus(storage) {
  const row = selectedRow(storage);
  return row ? { displayName: row.display_name, state: row.state, revision: Number(row.revision), lastVerifiedAt: row.last_verified_at === null ? null : Number(row.last_verified_at) } : null;
}
