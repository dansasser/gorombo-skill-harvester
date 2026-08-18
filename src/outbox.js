import { createId, sha256 } from "./ids.js";
import { DELIVERY_ATTEMPT_TIMEOUT_MS, DELIVERY_LEASE_MS, DELIVERY_RETRY_DELAYS_MS, MAX_DELIVERY_ATTEMPTS, TELEGRAM_MESSAGE_LIMIT } from "./constants.js";
import { renderDeliveryMessage, scanSafeContent, serializeCanonicalJson } from "./content.js";
import { markRecommendationRecovery } from "./harvester.js";
import { completeOnboardingIfReadyInTransaction } from "./onboarding.js";
import { primaryTelegramBinding } from "./pairing.js";

function safeJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = {};
  for (const key of ["code", "providerClass", "retryAfterAt", "renderedDigest", "method"]) {
    if (Object.hasOwn(value, key) && ["string", "number", "boolean"].includes(typeof value[key])) allowed[key] = value[key];
  }
  return allowed;
}

export function telegramRouteTestMessage() {
  return ["Gorombo Skill Harvester", "", "Telegram delivery test", "", "This confirms that Telegram alert delivery is configured. No skill recommendation was created."].join("\n");
}

function validRouteTestMessage(message) {
  return typeof message === "string" && message.startsWith("Gorombo Skill Harvester") && Array.from(message).length <= TELEGRAM_MESSAGE_LIMIT && scanSafeContent(message).ok;
}

export function enqueueTelegramRouteTest(storage, options, now = Date.now()) {
  if (!options || typeof options !== "object") throw new Error("telegram_route_test_invalid");
  return storage.transaction(function () {
    const route = storage.getRoute("telegram");
    if (!route || !route.selected || !["CONFIGURED", "VERIFYING", "READY", "DEGRADED"].includes(route.state)) throw new Error("telegram_route_test_unavailable");
    const binding = primaryTelegramBinding(storage, options.botIdentity, options.allowedUsers || null);
    if (!binding) throw new Error("telegram_unpaired");
    const existing = storage.db.prepare(
      "SELECT id,state,route_configuration_revision,route_test_generation,test_message_digest FROM delivery_outbox " +
      "WHERE delivery_kind='route_test' AND route='telegram' AND route_configuration_revision=? AND target_binding_id=? " +
      "AND state IN ('QUEUED','SENDING','RETRY_WAIT') ORDER BY route_test_generation DESC LIMIT 1"
    ).get(route.revision, binding.id);
    if (existing) return { status: "existing", deliveryId: existing.id, configurationRevision: Number(existing.route_configuration_revision), testGeneration: Number(existing.route_test_generation), renderedDigest: existing.test_message_digest };
    const message = options.message || telegramRouteTestMessage();
    if (!validRouteTestMessage(message)) throw new Error("telegram_route_test_invalid");
    const renderedDigest = sha256(Buffer.from(message, "utf8"));
    const prior = storage.db.prepare("SELECT COALESCE(MAX(route_test_generation),-1) AS generation FROM delivery_outbox WHERE delivery_kind='route_test' AND route='telegram' AND route_configuration_revision=?").get(route.revision);
    const testGeneration = Number(prior.generation) + 1;
    const deliveryId = createId("out");
    storage.setRouteState("telegram", "VERIFYING", now);
    storage.db.prepare(
      "INSERT INTO delivery_outbox(id,delivery_kind,recommendation_id,route_configuration_revision,route_test_generation,test_message,test_message_digest,target_binding_id,route,payload_version,delivery_generation,state,next_attempt_at,created_at,updated_at) " +
      "VALUES(?,'route_test',NULL,?,?,?,?,?,'telegram',1,0,'QUEUED',?,?,?)"
    ).run(deliveryId, route.revision, testGeneration, message, renderedDigest, binding.id, now, now, now);
    return { status: "queued", deliveryId, configurationRevision: route.revision, testGeneration, renderedDigest };
  });
}

function retryPlan(attemptNumber, now, retryAfterAt = null) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return { kind: "exhausted", due: null };
  const base = now + DELIVERY_RETRY_DELAYS_MS[attemptNumber - 1];
  if (retryAfterAt === null) return { kind: "retry", due: base };
  if (!Number.isSafeInteger(retryAfterAt) || retryAfterAt < 0) throw new Error("retry_after_invalid");
  if (retryAfterAt - now > 86_400_000) return { kind: "pause", due: null };
  return { kind: "retry", due: Math.max(base, retryAfterAt) };
}

export function retryDueAt(attemptNumber, now, retryAfterAt = null) {
  const plan = retryPlan(attemptNumber, now, retryAfterAt);
  return plan.kind === "retry" ? plan.due : null;
}

function completeExpiredRow(storage, row, now) {
  const due = retryDueAt(Number(row.attempt_count), now);
  storage.db.prepare("UPDATE delivery_attempts SET completed_at=?,result_category='lease_expired',safe_error_json=? WHERE delivery_id=? AND attempt_number=? AND completed_at IS NULL")
    .run(now, JSON.stringify({ code: "lease_expired" }), row.id, row.attempt_count);
  storage.db.prepare(
    "UPDATE delivery_outbox SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category='lease_expired',last_safe_error_json=?,ambiguous_acceptance=1,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=?"
  ).run(due === null ? "DEAD_LETTER" : "RETRY_WAIT", due === null ? now : due, JSON.stringify({ code: "lease_expired" }), now, due === null ? now : null, row.id, row.lease_token);
}

export function recoverExpiredLeases(storage, now = Date.now()) {
  return storage.transaction(function () {
    const rows = storage.db.prepare("SELECT * FROM delivery_outbox WHERE state='SENDING' AND lease_expires_at<=? ORDER BY lease_expires_at,id").all(now);
    for (const row of rows) completeExpiredRow(storage, row, now);
    return rows.length;
  });
}

export function claimNextDelivery(storage, workerId, now = Date.now()) {
  return storage.transaction(function () {
    const row = storage.db.prepare(
      "SELECT o.*,r.canonical_json,r.canonical_json_digest,r.visibility_state,c.state AS completion_state," +
      "q.selected AS route_selected,q.state AS route_state,q.revision AS current_route_revision," +
      "b.state AS binding_state,b.is_primary AS binding_primary,b.chat_type AS binding_chat_type FROM delivery_outbox o " +
      "JOIN route_configurations q ON q.route=o.route LEFT JOIN recommendations r ON r.id=o.recommendation_id " +
      "LEFT JOIN completion_events c ON c.id=r.completion_id LEFT JOIN telegram_bindings b ON b.id=o.target_binding_id " +
      "WHERE o.state IN ('QUEUED','RETRY_WAIT') AND o.next_attempt_at<=? AND q.selected=1 AND (" +
      "(o.delivery_kind='recommendation' AND q.state='READY' AND r.visibility_state='OWNER_VISIBLE' AND c.state<>'RECOVERY_REQUIRED') OR " +
      "(o.delivery_kind='route_test' AND o.route='telegram' AND q.state='VERIFYING' AND q.revision=o.route_configuration_revision AND b.chat_type='private' AND b.state='ACTIVE' AND b.is_primary=1)" +
      ") ORDER BY o.next_attempt_at,o.created_at,o.id LIMIT 1"
    ).get(now);
    if (!row) return null;
    const leaseToken=createId("run"),attemptNumber=Number(row.attempt_count)+1;
    const changed=storage.db.prepare("UPDATE delivery_outbox SET state='SENDING',attempt_count=?,lease_token=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state IN ('QUEUED','RETRY_WAIT')")
      .run(attemptNumber,leaseToken,workerId,now+DELIVERY_LEASE_MS,now,row.id);
    if(Number(changed.changes)!==1)return null;
    const attemptId=createId("att");
    storage.db.prepare("INSERT INTO delivery_attempts(id,delivery_id,attempt_number,lease_token,started_at) VALUES(?,?,?,?,?)").run(attemptId,row.id,attemptNumber,leaseToken,now);
    return {
      deliveryId:row.id,deliveryKind:row.delivery_kind,recommendationId:row.recommendation_id,route:row.route,payloadVersion:Number(row.payload_version),
      attemptNumber,attemptId,leaseToken,leaseOwner:workerId,leaseExpiresAt:now+DELIVERY_LEASE_MS,
      canonicalJson:row.canonical_json,canonicalDigest:row.canonical_json_digest,
      routeConfigurationRevision:row.route_configuration_revision===null?null:Number(row.route_configuration_revision),
      routeTestGeneration:row.route_test_generation===null?null:Number(row.route_test_generation),
      testMessage:row.test_message,testMessageDigest:row.test_message_digest,targetBindingId:row.target_binding_id
    };
  });
}

function deliveryRowEligible(row) {
  if (!row || !Boolean(row.route_selected)) return false;
  if (row.delivery_kind === "recommendation") return row.route_state === "READY" && row.visibility_state === "OWNER_VISIBLE" && row.completion_state !== "RECOVERY_REQUIRED";
  if (row.delivery_kind === "route_test") return row.route === "telegram" && row.route_state === "VERIFYING" && Number(row.current_route_revision) === Number(row.route_configuration_revision) && row.binding_chat_type === "private" && row.binding_state === "ACTIVE" && Boolean(row.binding_primary);
  return false;
}

export function deliveryClaimReady(storage, claim, now = Date.now()) {
  const row=storage.db.prepare(
    "SELECT o.*,r.visibility_state,c.state AS completion_state,q.selected AS route_selected,q.state AS route_state,q.revision AS current_route_revision," +
    "b.state AS binding_state,b.is_primary AS binding_primary,b.chat_type AS binding_chat_type FROM delivery_outbox o JOIN route_configurations q ON q.route=o.route " +
    "LEFT JOIN recommendations r ON r.id=o.recommendation_id LEFT JOIN completion_events c ON c.id=r.completion_id " +
    "LEFT JOIN telegram_bindings b ON b.id=o.target_binding_id WHERE o.id=?"
  ).get(claim.deliveryId);
  return Boolean(row&&row.state==="SENDING"&&row.lease_token===claim.leaseToken&&Number(row.lease_expires_at)>now&&deliveryRowEligible(row));
}

export function pauseIntegrityClaim(storage, claim, providerMayHaveAccepted = false, now = Date.now()) {
  return storage.transaction(function () {
    const row=storage.db.prepare("SELECT state,delivery_kind,route,route_configuration_revision,lease_token,lease_expires_at FROM delivery_outbox WHERE id=?").get(claim.deliveryId);
    if(!row||row.state!=="SENDING"||row.lease_token!==claim.leaseToken)return {status:"stale"};
    if(Number(row.lease_expires_at)<=now){const expired=storage.db.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(claim.deliveryId);completeExpiredRow(storage,expired,now);return {status:"expired"};}
    const category=providerMayHaveAccepted?"ambiguous":"cancelled";
    const code=row.delivery_kind==="route_test"?(providerMayHaveAccepted?"route_test_stale":"route_test_integrity"):(providerMayHaveAccepted?"integrity_after_send":"recommendation_integrity");
    storage.db.prepare("UPDATE delivery_attempts SET completed_at=?,result_category=?,safe_error_json=? WHERE id=? AND lease_token=? AND completed_at IS NULL").run(now,category,JSON.stringify({code}),claim.attemptId,claim.leaseToken);
    storage.db.prepare("UPDATE delivery_outbox SET state='PAUSED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,last_safe_error_json=?,ambiguous_acceptance=?,updated_at=? WHERE id=? AND state='SENDING' AND lease_token=?")
      .run(code,JSON.stringify({code}),providerMayHaveAccepted?1:0,now,claim.deliveryId,claim.leaseToken);
    if(row.delivery_kind==="route_test")storage.db.prepare("UPDATE route_configurations SET state=?,updated_at=? WHERE route=? AND revision=?").run(providerMayHaveAccepted?"DEGRADED":"RECOVERY_REQUIRED",now,row.route,row.route_configuration_revision);
    return {status:"paused"};
  });
}

export function renderClaim(claim) {
  if(claim.deliveryKind==="route_test"){
    if(!validRouteTestMessage(claim.testMessage)||sha256(Buffer.from(claim.testMessage,"utf8"))!==claim.testMessageDigest||typeof claim.targetBindingId!=="string")throw new Error("route_test_integrity");
    return Object.freeze({payloadVersion:claim.payloadVersion,recommendationId:null,route:claim.route,title:"Telegram delivery test",plainText:claim.testMessage,canonicalContentDigest:null,renderedDigest:claim.testMessageDigest,targetBindingId:claim.targetBindingId,omittedSections:[]});
  }
  const content=JSON.parse(claim.canonicalJson);
  if(serializeCanonicalJson(content).digest!==claim.canonicalDigest)throw new Error("recommendation_integrity");
  return renderDeliveryMessage(content,claim.route,claim.route==="telegram"?TELEGRAM_MESSAGE_LIMIT:12_000);
}

function setClaimRouteState(storage,row,state,now){
  if(row.delivery_kind==="route_test")storage.db.prepare("UPDATE route_configurations SET state=?,updated_at=? WHERE route=? AND revision=?").run(state,now,row.route,row.route_configuration_revision);
  else storage.db.prepare("UPDATE route_configurations SET state=?,updated_at=? WHERE route=?").run(state,now,row.route);
}

export function completeDelivery(storage, claim, result, now = Date.now()) {
  if(!result||typeof result!=="object"||!["accepted","retryable","rateLimited","routeBlocked","permanent","ambiguous"].includes(result.category))throw new Error("adapter_result_invalid");
  return storage.transaction(function(){
    const row=storage.db.prepare(
      "SELECT o.*,r.visibility_state,c.state AS completion_state,q.selected AS route_selected,q.state AS route_state,q.revision AS current_route_revision,"+
      "b.state AS binding_state,b.is_primary AS binding_primary,b.chat_type AS binding_chat_type FROM delivery_outbox o JOIN route_configurations q ON q.route=o.route "+
      "LEFT JOIN recommendations r ON r.id=o.recommendation_id LEFT JOIN completion_events c ON c.id=r.completion_id "+
      "LEFT JOIN telegram_bindings b ON b.id=o.target_binding_id WHERE o.id=?"
    ).get(claim.deliveryId);
    if(!row||row.state!=="SENDING"||row.lease_token!==claim.leaseToken)return {status:"stale"};
    if(Number(row.lease_expires_at)<=now){completeExpiredRow(storage,row,now);return {status:"expired"};}
    const eligible=deliveryRowEligible(row);
    if((row.delivery_kind==="recommendation"&&!eligible)||(row.delivery_kind==="route_test"&&result.category!=="accepted"&&!eligible)){
      const code=row.delivery_kind==="route_test"?"route_test_stale":"integrity_after_send";
      storage.db.prepare("UPDATE delivery_attempts SET completed_at=?,result_category='ambiguous',safe_error_json=? WHERE id=? AND lease_token=? AND completed_at IS NULL").run(now,JSON.stringify({code}),claim.attemptId,claim.leaseToken);
      storage.db.prepare("UPDATE delivery_outbox SET state='PAUSED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,last_safe_error_json=?,ambiguous_acceptance=1,updated_at=? WHERE id=? AND state='SENDING' AND lease_token=?").run(code,JSON.stringify({code}),now,claim.deliveryId,claim.leaseToken);
      if(row.delivery_kind==="route_test")setClaimRouteState(storage,row,"DEGRADED",now);
      return {status:"paused"};
    }
    if(result.category==="accepted"){
      if(typeof result.providerReceiptRef!=="string"||result.providerReceiptRef.length<1||result.providerReceiptRef.length>256)throw new Error("adapter_result_invalid");
      const receipt=safeJson(result.safeReceipt||{}),renderedDigest=renderClaim(claim).renderedDigest;
      if(!/^[a-f0-9]{64}$/u.test(String(receipt.renderedDigest||""))||receipt.renderedDigest!==renderedDigest)throw new Error("adapter_result_invalid");
      const receiptId=createId("rcp");
      const attempt=storage.db.prepare("UPDATE delivery_attempts SET completed_at=?,result_category='accepted',safe_error_json=NULL WHERE id=? AND lease_token=? AND completed_at IS NULL").run(now,claim.attemptId,claim.leaseToken);
      if(Number(attempt.changes)!==1)return {status:"stale"};
      storage.db.prepare("INSERT INTO delivery_receipts(id,delivery_id,attempt_id,provider_receipt_ref,accepted_at,safe_receipt_json) VALUES(?,?,?,?,?,?)").run(receiptId,claim.deliveryId,claim.attemptId,result.providerReceiptRef,now,JSON.stringify(receipt));
      const delivered=storage.db.prepare("UPDATE delivery_outbox SET state='SENT',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=NULL,last_safe_error_json=NULL,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_expires_at>?").run(now,now,claim.deliveryId,claim.leaseToken,now);
      if(Number(delivered.changes)!==1)throw new Error("delivery_claim_stale");
      if(row.delivery_kind==="route_test"){
        storage.db.prepare("INSERT INTO route_test_receipts(id,delivery_id,route,configuration_revision,test_generation,provider_receipt_ref,accepted_at,safe_receipt_json) VALUES(?,?,'telegram',?,?,?,?,?)")
          .run(createId("rcp"),claim.deliveryId,row.route_configuration_revision,row.route_test_generation,result.providerReceiptRef,now,JSON.stringify(receipt));
        if(eligible){
          const route=storage.db.prepare("UPDATE route_configurations SET state='READY',updated_at=? WHERE route='telegram' AND selected=1 AND state='VERIFYING' AND revision=?").run(now,row.route_configuration_revision);
          if(Number(route.changes)===1)completeOnboardingIfReadyInTransaction(storage,now);
          return {status:"sent",receiptId};
        }
        return {status:"sent_stale_configuration",receiptId};
      }
      return {status:"sent",receiptId};
    }
    const categoryMap={retryable:"retryable",rateLimited:"rate_limited",routeBlocked:"route_blocked",permanent:"permanent",ambiguous:"ambiguous"};
    let error=safeJson(result.safeError||{}),storedCategory=categoryMap[result.category],state,due=now,terminalAt=null;
    if(result.category==="routeBlocked"){state="PAUSED";setClaimRouteState(storage,row,"DEGRADED",now);}
    else if(result.category==="permanent"){state="DEAD_LETTER";terminalAt=now;if(row.delivery_kind==="route_test")setClaimRouteState(storage,row,"DEGRADED",now);}
    else{
      const plan=retryPlan(Number(row.attempt_count),now,result.category==="rateLimited"?result.retryAfterAt:null);
      if(plan.kind==="pause"){state="PAUSED";storedCategory="retry_after_exceeds_policy";error={code:"retry_after_exceeds_policy"};setClaimRouteState(storage,row,"DEGRADED",now);}
      else if(plan.kind==="exhausted"){state="DEAD_LETTER";terminalAt=now;if(row.delivery_kind==="route_test")setClaimRouteState(storage,row,"DEGRADED",now);}
      else{state="RETRY_WAIT";due=plan.due;}
    }
    storage.db.prepare("UPDATE delivery_attempts SET completed_at=?,result_category=?,safe_error_json=? WHERE id=? AND lease_token=? AND completed_at IS NULL").run(now,categoryMap[result.category],JSON.stringify(error),claim.attemptId,claim.leaseToken);
    const changed=storage.db.prepare("UPDATE delivery_outbox SET state=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_category=?,last_safe_error_json=?,ambiguous_acceptance=?,updated_at=?,terminal_at=? WHERE id=? AND state='SENDING' AND lease_token=? AND lease_expires_at>?")
      .run(state,due,storedCategory,JSON.stringify(error),result.category==="ambiguous"?1:Number(row.ambiguous_acceptance),now,terminalAt,claim.deliveryId,claim.leaseToken,now);
    if(Number(changed.changes)!==1)return {status:"stale"};
    return {status:state.toLowerCase(),nextAttemptAt:state==="RETRY_WAIT"?due:null};
  });
}

export function nextDeliveryDueAt(storage) {
  const queued=storage.db.prepare(
    "SELECT MIN(o.next_attempt_at) AS due FROM delivery_outbox o JOIN route_configurations q ON q.route=o.route "+
    "LEFT JOIN recommendations r ON r.id=o.recommendation_id LEFT JOIN completion_events c ON c.id=r.completion_id "+
    "LEFT JOIN telegram_bindings b ON b.id=o.target_binding_id WHERE o.state IN ('QUEUED','RETRY_WAIT') AND q.selected=1 AND ("+
    "(o.delivery_kind='recommendation' AND q.state='READY' AND r.visibility_state='OWNER_VISIBLE' AND c.state<>'RECOVERY_REQUIRED') OR "+
    "(o.delivery_kind='route_test' AND o.route='telegram' AND q.state='VERIFYING' AND q.revision=o.route_configuration_revision AND b.chat_type='private' AND b.state='ACTIVE' AND b.is_primary=1))"
  ).get();
  const lease=storage.db.prepare("SELECT MIN(lease_expires_at) AS due FROM delivery_outbox WHERE state='SENDING'").get();
  const values=[queued&&queued.due,lease&&lease.due].filter(value=>value!==null&&value!==undefined).map(Number);
  return values.length?Math.min(...values):null;
}

export function pauseRoute(storage, route, code, now = Date.now()) {
  return storage.transaction(function () {
    storage.db.prepare("UPDATE route_configurations SET state='DEGRADED',updated_at=? WHERE route=?").run(now, route);
    const changed = storage.db.prepare("UPDATE delivery_outbox SET state='PAUSED',last_error_category=?,last_safe_error_json=?,updated_at=? WHERE route=? AND state IN ('QUEUED','RETRY_WAIT')")
      .run(code, JSON.stringify({ code }), now, route);
    return Number(changed.changes);
  });
}

export function resumeRoute(storage, route, now = Date.now()) {
  if (route === "session") throw new Error("session_reselection_required");
  return storage.transaction(function () {
    storage.db.prepare("UPDATE route_configurations SET state='READY',updated_at=? WHERE route=?").run(now, route);
    const changed = storage.db.prepare("UPDATE delivery_outbox SET state='RETRY_WAIT',next_attempt_at=?,last_error_category=NULL,last_safe_error_json=NULL,updated_at=? WHERE route=? AND delivery_kind='recommendation' AND state='PAUSED' AND last_error_category IN ('route_disabled','route_blocked','session_busy','connection_unavailable','retry_after_exceeds_policy')")
      .run(now, now, route);
    return Number(changed.changes);
  });
}

export function replayDelivery(storage, deliveryId, replayRequestId, requestedBy, safeReason, now = Date.now()) {
  if (!/^rpl_[0-9a-f]{32}$/u.test(replayRequestId) || typeof safeReason !== "string" || safeReason.length < 1 || safeReason.length > 500) throw new Error("replay_invalid");
  return storage.transaction(function () {
    const existing = storage.db.prepare("SELECT replay_delivery_id FROM delivery_replays WHERE replay_request_id=?").get(replayRequestId);
    if (existing) return { replayDeliveryId: existing.replay_delivery_id, existing: true };
    const original = storage.db.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(deliveryId);
    if (!original || original.state !== "DEAD_LETTER" || original.delivery_kind !== "recommendation") throw new Error("replay_not_allowed");
    const generation = Number(storage.db.prepare("SELECT MAX(delivery_generation) AS value FROM delivery_outbox WHERE recommendation_id=? AND route=? AND payload_version=?").get(original.recommendation_id, original.route, original.payload_version).value) + 1;
    const id = createId("out");
    storage.db.prepare("INSERT INTO delivery_outbox(id,recommendation_id,route,payload_version,delivery_generation,state,next_attempt_at,replay_of_delivery_id,created_at,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,?,?,?)")
      .run(id, original.recommendation_id, original.route, original.payload_version, generation, now, original.id, now, now);
    storage.db.prepare("INSERT INTO delivery_replays(replay_request_id,original_delivery_id,replay_delivery_id,requested_by,safe_reason,requested_at) VALUES(?,?,?,?,?,?)")
      .run(replayRequestId, original.id, id, requestedBy, safeReason, now);
    return { replayDeliveryId: id, existing: false };
  });
}

function markClaimRecovery(storage, claim, code, now) {
  if (claim.deliveryKind === "route_test") storage.db.prepare("UPDATE route_configurations SET state='RECOVERY_REQUIRED',updated_at=? WHERE route=? AND revision=?").run(now, claim.route, claim.routeConfigurationRevision);
  else markRecommendationRecovery(storage, claim.recommendationId, code, now);
}

async function sendWithDeadline(adapter, envelope, controller, clock, timeoutMs) {
  let timer = null;
  const adapterResult = Promise.resolve().then(function () {
    return adapter.send(envelope, controller.signal);
  }).then(
    function (value) { return { kind: "result", value }; },
    function () { return { kind: "error" }; }
  );
  const deadline = new Promise(function (resolve) {
    timer = clock.setTimeout(function () {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const outcome = await Promise.race([adapterResult, deadline]);
  if (outcome.kind !== "timeout" && timer !== null) clock.clearTimeout(timer);
  if (outcome.kind === "result") return outcome.value;
  if (outcome.kind === "timeout") return { category: "ambiguous", safeError: { code: "adapter_timeout" } };
  return { category: "retryable", safeError: { code: "adapter_failure" } };
}

export class OutboxDispatcher {
  constructor(options) {
    this.storage = options.storage;
    this.adapters = options.adapters;
    this.workerId = options.workerId || createId("run");
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.attemptTimeoutMs = options.attemptTimeoutMs || DELIVERY_ATTEMPT_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs || 30_000;
    this.onCompleted = typeof options.onCompleted === "function" ? options.onCompleted : async function () {};
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
    recoverExpiredLeases(this.storage, this.clock.now());
    this.wake("startup");
  }

  wake() {
    if (!this.running) return;
    this.generation += 1;
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
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
        recoverExpiredLeases(this.storage, this.clock.now());
        let claim;
        while (this.running && (claim = claimNextDelivery(this.storage, this.workerId, this.clock.now()))) {
          let envelope;
          try {
            envelope = renderClaim(claim);
          } catch {
            markClaimRecovery(this.storage, claim, claim.deliveryKind === "route_test" ? "route_test_integrity" : "recommendation_integrity", this.clock.now());
            pauseIntegrityClaim(this.storage, claim, false, this.clock.now());
            continue;
          }
          if (!deliveryClaimReady(this.storage, claim, this.clock.now())) {
            pauseIntegrityClaim(this.storage, claim, false, this.clock.now());
            continue;
          }
          const adapter = this.adapters[claim.route];
          let result;
          if (!adapter) result = { category: "routeBlocked", safeError: { code: "adapter_missing" } };
          else {
            const controller = new AbortController();
            this.activeAbort = controller;
            try { result = await sendWithDeadline(adapter, envelope, controller, this.clock, this.attemptTimeoutMs); }
            finally { if (this.activeAbort === controller) this.activeAbort = null; }
          }
          try {
            const completed = completeDelivery(this.storage, claim, result, this.clock.now());
            try { await this.onCompleted({ claim, result: completed }); } catch {}
          } catch {
            try {
              completeDelivery(this.storage, claim, { category: "permanent", safeError: { code: "adapter_contract_invalid" } }, this.clock.now());
            } catch {
              markClaimRecovery(this.storage, claim, "delivery_result_invalid", this.clock.now());
              pauseIntegrityClaim(this.storage, claim, true, this.clock.now());
            }
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
    const due = nextDeliveryDueAt(this.storage);
    if (due === null) return;
    const generation = ++this.generation;
    const delay = Math.max(0, Math.min(2_147_483_647, due - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.running && generation === this.generation) this.wake("timer");
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
