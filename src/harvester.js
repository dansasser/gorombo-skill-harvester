import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createId, sha256 } from "./ids.js";
import { finalizeRecommendation, renderCanonicalMarkdown, scanSafeContent, serializeCanonicalJson } from "./content.js";
import { ensureOwnedDirectory, resolveStoredRelative, validateStoredRelative } from "./paths.js";
import { validateAssessmentOutcome } from "./assessment.js";
import { PAYLOAD_VERSION } from "./constants.js";

const EVIDENCE_KINDS = new Set(["user_request", "agent_result", "tool_summary", "artifact_ref", "constraint"]);
const ASSESSMENT_LEASE_MS = 120_000;
const ASSESSMENT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const MAX_ASSESSMENT_ATTEMPTS = 5;

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(code);
}

function boundedText(value, code, maximumBytes) {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maximumBytes || !scanSafeContent(normalized).ok) throw new Error(code);
  return normalized;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 32) throw new Error("completion_evidence_invalid");
  let scalarTotal = 0;
  return evidence.map(function (item) {
    const allowed = item && Object.hasOwn(item, "artifactPath") ? ["kind", "text", "artifactPath"] : ["kind", "text"];
    exactKeys(item, allowed, "completion_evidence_invalid");
    if (!EVIDENCE_KINDS.has(item.kind)) throw new Error("completion_evidence_invalid");
    const text = boundedText(item.text, "completion_evidence_invalid", 8000);
    scalarTotal += Array.from(text).length;
    if (scalarTotal > 16000) throw new Error("completion_evidence_invalid");
    const normalized = { kind: item.kind, text };
    if (item.artifactPath !== undefined) normalized.artifactPath = validateStoredRelative(item.artifactPath);
    return normalized;
  });
}

export function completionIdentity(platform, taskId, generation, sourceRevision) {
  const text = JSON.stringify({ platform, taskId, generation, sourceRevision }) + "\n";
  return sha256(Buffer.from(text, "utf8"));
}

export function completionEvidenceIdentity(evidence) {
  return sha256(Buffer.from(JSON.stringify(evidence) + "\n", "utf8"));
}

export function createCompletionEvent(input) {
  const evidence = normalizeEvidence(input.evidence);
  const taskId = boundedText(input.taskId, "completion_task_invalid", 256);
  const sourceRevision = boundedText(input.sourceRevision, "completion_revision_invalid", 128);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !Number.isSafeInteger(input.completedAt) || input.completedAt < 0) throw new Error("completion_time_invalid");
  const correlationKey = completionIdentity("codex", taskId, input.generation, sourceRevision);
  return Object.freeze({
    schemaVersion: 1,
    platform: "codex",
    adapterVersion: "codex-goal-completion-v1",
    taskId,
    terminalStatus: "complete",
    generation: input.generation,
    completedAt: input.completedAt,
    sourceRevision,
    correlationKey,
    completionEvidenceDigest: completionEvidenceIdentity(evidence),
    evidence
  });
}

export function validateCompletionEvent(event) {
  exactKeys(event, ["schemaVersion", "platform", "adapterVersion", "taskId", "terminalStatus", "generation", "completedAt", "sourceRevision", "correlationKey", "completionEvidenceDigest", "evidence"], "completion_event_invalid");
  if (event.schemaVersion !== 1 || event.platform !== "codex" || event.adapterVersion !== "codex-goal-completion-v1" || event.terminalStatus !== "complete") throw new Error("completion_event_invalid");
  const rebuilt = createCompletionEvent(event);
  if (rebuilt.correlationKey !== event.correlationKey || rebuilt.completionEvidenceDigest !== event.completionEvidenceDigest) throw new Error("completion_digest_mismatch");
  return rebuilt;
}

function recordOperational(storage, component, eventType, correlationId, detail = {}, now = Date.now()) {
  storage.db.prepare("INSERT INTO operational_events(id,component,event_type,correlation_id,safe_detail_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(createId("op"), component, eventType, correlationId || null, JSON.stringify(detail), now);
}

export function acceptCompletion(storage, event, now = Date.now()) {
  const valid = validateCompletionEvent(event);
  return storage.transaction(function () {
    const existing = storage.db.prepare("SELECT id,safe_evidence_digest,state FROM completion_events WHERE correlation_key = ?").get(valid.correlationKey);
    if (existing) {
      if (existing.safe_evidence_digest !== valid.completionEvidenceDigest) {
        storage.db.prepare("UPDATE completion_events SET state='RECOVERY_REQUIRED',assessment_next_at=NULL WHERE id=?").run(existing.id);
        recordOperational(storage, "harvester", "correlation_conflict", existing.id, { code: "evidence_digest_mismatch" }, now);
        return { status: "recovery_required", completionId: existing.id };
      }
      return { status: "accepted_existing", completionId: existing.id, state: existing.state };
    }
    const id = createId("evt");
    storage.db.prepare(
      "INSERT INTO completion_events(id,correlation_key,source_platform,source_adapter,source_event_id,task_id,source_generation,completed_at,source_revision,safe_evidence_json,safe_evidence_digest,state,assessment_next_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id, valid.correlationKey, valid.platform, valid.adapterVersion, valid.correlationKey, valid.taskId, valid.generation, valid.completedAt, valid.sourceRevision, JSON.stringify(valid.evidence), valid.completionEvidenceDigest, "ASSESSMENT_PENDING", now, now);
    recordOperational(storage, "harvester", "completion.accepted", id, {}, now);
    return { status: "accepted_new", completionId: id };
  });
}

export function persistCatalogSnapshot(storage, catalog, now = Date.now()) {
  return storage.transaction(function () {
    const existing = storage.db.prepare("SELECT canonical_json FROM skill_catalog_snapshots WHERE revision=?").get(catalog.revision);
    if (existing) {
      if (existing.canonical_json !== catalog.canonicalJson) throw new Error("catalog_revision_conflict");
      return catalog.revision;
    }
    storage.db.prepare("INSERT INTO skill_catalog_snapshots(revision,catalog_schema_version,canonical_json,created_at) VALUES(?,?,?,?)")
      .run(catalog.revision, 1, catalog.canonicalJson, now);
    return catalog.revision;
  });
}

export function assessmentRetryDueAt(attemptNumber, now) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= MAX_ASSESSMENT_ATTEMPTS) return null;
  return now + ASSESSMENT_RETRY_DELAYS_MS[attemptNumber - 1];
}

function recoverExpiredAssessmentRows(storage, now) {
  const rows = storage.db.prepare(
    "SELECT id,assessment_attempts,assessment_lease_token FROM completion_events WHERE state='ASSESSMENT_PENDING' AND assessment_lease_expires_at IS NOT NULL AND assessment_lease_expires_at<=? ORDER BY assessment_lease_expires_at,id"
  ).all(now);
  for (const row of rows) {
    const due = assessmentRetryDueAt(Number(row.assessment_attempts), now);
    if (due === null) {
      const changed = storage.db.prepare(
        "UPDATE completion_events SET state='RECOVERY_REQUIRED',assessment_next_at=NULL,assessment_lease_token=NULL,assessment_lease_owner=NULL,assessment_lease_expires_at=NULL WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_lease_token=? AND assessment_lease_expires_at<=?"
      ).run(row.id, row.assessment_lease_token, now);
      if (Number(changed.changes) === 1) recordOperational(storage, "harvester", "assessment.exhausted", row.id, { code: "assessment_exhausted" }, now);
    } else {
      const changed = storage.db.prepare(
        "UPDATE completion_events SET assessment_next_at=?,assessment_lease_token=NULL,assessment_lease_owner=NULL,assessment_lease_expires_at=NULL WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_lease_token=? AND assessment_lease_expires_at<=?"
      ).run(due, row.id, row.assessment_lease_token, now);
      if (Number(changed.changes) === 1) recordOperational(storage, "harvester", "assessment.retry", row.id, { code: "lease_expired" }, now);
    }
  }
  return rows.length;
}

export function recoverExpiredAssessmentLeases(storage, now = Date.now()) {
  return storage.transaction(function () { return recoverExpiredAssessmentRows(storage, now); });
}

export function claimAssessment(storage, workerId, now = Date.now()) {
  return storage.transaction(function () {
    recoverExpiredAssessmentRows(storage, now);
    const row = storage.db.prepare(
      "SELECT * FROM completion_events WHERE state='ASSESSMENT_PENDING' AND assessment_attempts<? AND assessment_next_at<=? AND assessment_lease_token IS NULL ORDER BY assessment_next_at,received_at,id LIMIT 1"
    ).get(MAX_ASSESSMENT_ATTEMPTS, now);
    if (!row) return null;
    const token = createId("run");
    const changed = storage.db.prepare(
      "UPDATE completion_events SET assessment_attempts=assessment_attempts+1,assessment_lease_token=?,assessment_lease_owner=?,assessment_lease_expires_at=? WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_attempts<? AND assessment_lease_token IS NULL"
    ).run(token, workerId, now + ASSESSMENT_LEASE_MS, row.id, MAX_ASSESSMENT_ATTEMPTS);
    if (Number(changed.changes) !== 1) return null;
    return {
      completionId: row.id,
      correlationKey: row.correlation_key,
      taskId: row.task_id,
      sourceRevision: row.source_revision,
      safeEvidence: JSON.parse(row.safe_evidence_json),
      safeEvidenceDigest: row.safe_evidence_digest,
      leaseToken: token,
      leaseOwner: workerId,
      leaseExpiresAt: now + ASSESSMENT_LEASE_MS,
      attemptNumber: Number(row.assessment_attempts) + 1
    };
  });
}

export function releaseAssessmentClaim(storage, claim, safeCode, now = Date.now()) {
  return storage.transaction(function () {
    const due = assessmentRetryDueAt(claim.attemptNumber, now);
    if (due === null) {
      const changed = storage.db.prepare(
        "UPDATE completion_events SET state='RECOVERY_REQUIRED',assessment_next_at=NULL,assessment_lease_token=NULL,assessment_lease_owner=NULL,assessment_lease_expires_at=NULL WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_lease_token=? AND assessment_lease_owner=? AND assessment_lease_expires_at>?"
      ).run(claim.completionId, claim.leaseToken, claim.leaseOwner, now);
      if (Number(changed.changes) !== 1) return false;
      recordOperational(storage, "harvester", "assessment.exhausted", claim.completionId, { code: "assessment_exhausted" }, now);
      return true;
    }
    const changed = storage.db.prepare(
      "UPDATE completion_events SET assessment_lease_token=NULL,assessment_lease_owner=NULL,assessment_lease_expires_at=NULL,assessment_next_at=? WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_lease_token=? AND assessment_lease_owner=? AND assessment_lease_expires_at>?"
    ).run(due, claim.completionId, claim.leaseToken, claim.leaseOwner, now);
    if (Number(changed.changes) !== 1) return false;
    recordOperational(storage, "harvester", "assessment.retry", claim.completionId, { code: safeCode }, now);
    return true;
  });
}

export function recordAssessment(storage, claim, catalog, rawOutcome, assessmentVersion = "harvester-assessment-v1", now = Date.now()) {
  if (!catalog || !catalog.snapshot || !Array.isArray(catalog.snapshot.rootErrors) || catalog.snapshot.rootErrors.length > 0) throw new Error("catalog_incomplete");
  const outcome = validateAssessmentOutcome(rawOutcome, catalog.snapshot);
  const assessmentId = createId("asm");
  let recommendation = null;
  if (outcome.decision === "propose-new") {
    const recommendationId = createId("rec");
    const content = finalizeRecommendation({ ...outcome.recommendation, sourceRevision: claim.sourceRevision }, recommendationId, now);
    const canonical = serializeCanonicalJson(content);
    const markdown = renderCanonicalMarkdown(content);
    recommendation = { id: recommendationId, content, canonical, markdown, relativePath: "recommendations/" + recommendationId + ".md" };
  }
  const result = storage.transaction(function () {
    const current = storage.db.prepare("SELECT state,assessment_lease_token,assessment_lease_owner,assessment_lease_expires_at FROM completion_events WHERE id=?").get(claim.completionId);
    if (!current || current.state !== "ASSESSMENT_PENDING" || current.assessment_lease_token !== claim.leaseToken || current.assessment_lease_owner !== claim.leaseOwner || Number(current.assessment_lease_expires_at) <= now) throw new Error("assessment_claim_stale");
    const snapshot = storage.db.prepare("SELECT canonical_json FROM skill_catalog_snapshots WHERE revision=?").get(catalog.revision);
    if (!snapshot || snapshot.canonical_json !== catalog.canonicalJson) throw new Error("catalog_snapshot_missing");
    storage.db.prepare(
      "INSERT INTO assessments(id,completion_id,assessment_version,catalog_revision,decision,reason_code,reason_summary,target_skill_ref,target_skill_name,extension_summary,recommendation_id,recommendation_json,recommendation_digest,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      assessmentId, claim.completionId, assessmentVersion, catalog.revision, outcome.decision,
      outcome.reasonCode || null, outcome.reasonSummary, outcome.targetSkillRef || null, outcome.targetSkillName || null,
      outcome.extensionSummary || null, recommendation ? recommendation.id : null,
      recommendation ? recommendation.canonical.text : null, recommendation ? recommendation.canonical.digest : null, now
    );
    if (recommendation) {
      storage.db.prepare(
        "INSERT INTO recommendations(id,completion_id,assessment_id,content_schema_version,canonical_json,canonical_json_digest,markdown_relative_path,markdown_sha256,visibility_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
      ).run(recommendation.id, claim.completionId, assessmentId, 1, recommendation.canonical.text, recommendation.canonical.digest, recommendation.relativePath, recommendation.markdown.digest, "DRAFT_COMMITTED", now);
    }
    const nextState = recommendation ? "PUBLICATION_PENDING" : "ACK_PENDING";
    const changed = storage.db.prepare(
      "UPDATE completion_events SET state=?,assessment_next_at=NULL,assessment_lease_token=NULL,assessment_lease_owner=NULL,assessment_lease_expires_at=NULL WHERE id=? AND state='ASSESSMENT_PENDING' AND assessment_lease_token=? AND assessment_lease_owner=? AND assessment_lease_expires_at>?"
    ).run(nextState, claim.completionId, claim.leaseToken, claim.leaseOwner, now);
    if (Number(changed.changes) !== 1) throw new Error("assessment_claim_stale");
    recordOperational(storage, "harvester", "assessment.committed", claim.completionId, { decision: outcome.decision }, now);
    return { assessmentId, completionId: claim.completionId, decision: outcome.decision, recommendationId: recommendation ? recommendation.id : null };
  });
  if (!recommendation) acknowledgeCompletion(storage, claim.completionId, now);
  return result;
}

function rebuildRecommendation(row) {
  const parsed = JSON.parse(row.canonical_json);
  const draft = {
    skillName: parsed.skillName,
    purpose: parsed.purpose,
    whyRecommended: parsed.whyRecommended,
    whenToUse: parsed.whenToUse,
    suggestedProcedure: parsed.suggestedProcedure,
    evidenceSummary: parsed.evidenceSummary,
    proposedFiles: parsed.proposedFiles,
    resources: parsed.resources,
    overlapSummary: parsed.overlapSummary,
    exclusions: parsed.exclusions,
    nextReviewAction: parsed.nextReviewAction
  };
  if (parsed.sourceRevision !== undefined) draft.sourceRevision = parsed.sourceRevision;
  const rebuilt = finalizeRecommendation(draft, parsed.recommendationId, parsed.createdAt);
  const canonical = serializeCanonicalJson(rebuilt);
  const markdown = renderCanonicalMarkdown(rebuilt);
  if (canonical.text !== row.canonical_json || canonical.digest !== row.canonical_json_digest || markdown.digest !== row.markdown_sha256) throw new Error("recommendation_integrity");
  return { content: rebuilt, canonical, markdown };
}

async function hashFileSafe(file) {
  const info = await fsp.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("recommendation_path_unsafe");
  return sha256(await fsp.readFile(file));
}

async function writeRecommendationFile(layout, row, markdown) {
  const finalPath = resolveStoredRelative(layout.productRoot, row.markdown_relative_path);
  const parent = path.dirname(finalPath);
  await ensureOwnedDirectory(layout.productRoot, parent);
  try {
    if (await hashFileSafe(finalPath) !== row.markdown_sha256) throw new Error("recommendation_integrity");
    return finalPath;
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, "." + row.id + "." + process.pid + ".tmp");
  let handle;
  try {
    await ensureOwnedDirectory(layout.productRoot, parent);
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(markdown.bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await ensureOwnedDirectory(layout.productRoot, parent);
    try {
      await fsp.link(temporary, finalPath);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (await hashFileSafe(finalPath) !== row.markdown_sha256) throw new Error("recommendation_integrity");
      await fsp.unlink(temporary);
      return finalPath;
    }
    await fsp.unlink(temporary);
    if (process.platform !== "win32") await fsp.chmod(finalPath, 0o600);
    if (process.platform !== "win32") {
      const directory = await fsp.open(parent, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (handle) await handle.close().catch(function () {});
    await fsp.unlink(temporary).catch(function () {});
    throw error;
  }
  await ensureOwnedDirectory(layout.productRoot, parent);
  if (await hashFileSafe(finalPath) !== row.markdown_sha256) throw new Error("recommendation_integrity");
  return finalPath;
}

export function markRecommendationRecovery(storage, recommendationId, code, now) {
  storage.transaction(function () {
    const row = storage.db.prepare("SELECT completion_id FROM recommendations WHERE id=?").get(recommendationId);
    if (!row) return;
    storage.db.prepare("UPDATE recommendations SET visibility_state='RECOVERY_REQUIRED' WHERE id=?").run(recommendationId);
    storage.db.prepare("UPDATE completion_events SET state='RECOVERY_REQUIRED',assessment_next_at=NULL,ack_next_at=NULL WHERE id=?").run(row.completion_id);
    storage.db.prepare("UPDATE delivery_outbox SET state='PAUSED',last_error_category=?,last_safe_error_json=?,updated_at=? WHERE recommendation_id=? AND state NOT IN ('SENT','DEAD_LETTER','SENDING')")
      .run(code, JSON.stringify({ code }), now, recommendationId);
    recordOperational(storage, "harvester", "harvester.recovery_required", recommendationId, { code }, now);
  });
}

export async function publishRecommendation(storage, layout, recommendationId, wake = function () {}, now = Date.now()) {
  const row = storage.db.prepare("SELECT r.*,c.state AS completion_state FROM recommendations r JOIN completion_events c ON c.id=r.completion_id WHERE r.id=?").get(recommendationId);
  if (!row) throw new Error("recommendation_missing");
  let rebuilt;
  try { rebuilt = rebuildRecommendation(row); }
  catch (error) { markRecommendationRecovery(storage, recommendationId, "recommendation_integrity", now); throw error; }
  try { await writeRecommendationFile(layout, row, rebuilt.markdown); }
  catch (error) {
    if (["recommendation_integrity", "recommendation_path_unsafe", "owned_path_unsafe", "path_outside_owned_root"].includes(error && error.message)) {
      markRecommendationRecovery(storage, recommendationId, error.message === "recommendation_integrity" ? "recommendation_integrity" : "recommendation_path_unsafe", now);
    }
    throw error;
  }

  let outboxIds;
  try {
    outboxIds = storage.transaction(function () {
      const current = storage.db.prepare(
        "SELECT r.visibility_state,r.completion_id,c.state AS completion_state FROM recommendations r JOIN completion_events c ON c.id=r.completion_id WHERE r.id=?"
      ).get(recommendationId);
      if (!current || current.visibility_state === "RECOVERY_REQUIRED") throw new Error("recommendation_integrity");
      if (current.visibility_state === "DRAFT_COMMITTED") {
        if (current.completion_state !== "PUBLICATION_PENDING") throw new Error("publication_state_invalid");
        const visible = storage.db.prepare("UPDATE recommendations SET visibility_state='OWNER_VISIBLE',visible_at=? WHERE id=? AND visibility_state='DRAFT_COMMITTED'").run(now, recommendationId);
        const scheduled = storage.db.prepare("UPDATE completion_events SET state='OWNER_VISIBLE_AND_SCHEDULED',scheduled_at=? WHERE id=? AND state='PUBLICATION_PENDING'").run(now, current.completion_id);
        if (Number(visible.changes) !== 1 || Number(scheduled.changes) !== 1) throw new Error("publication_state_invalid");
      } else if (current.visibility_state !== "OWNER_VISIBLE" || !["OWNER_VISIBLE_AND_SCHEDULED", "ACK_PENDING", "ACKNOWLEDGED"].includes(current.completion_state)) {
        throw new Error("publication_state_invalid");
      }
      const routes = storage.db.prepare("SELECT route FROM route_configurations WHERE selected=1 ORDER BY route").all();
      const ids = [];
      for (const routeRow of routes) {
        const existing = storage.db.prepare("SELECT id FROM delivery_outbox WHERE recommendation_id=? AND route=? AND payload_version=? AND delivery_generation=0").get(recommendationId, routeRow.route, PAYLOAD_VERSION);
        if (existing) ids.push(existing.id);
        else {
          const id = createId("out");
          storage.db.prepare("INSERT INTO delivery_outbox(id,recommendation_id,route,payload_version,delivery_generation,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,0,'INTEGRITY_PENDING',?,?,?)")
            .run(id, recommendationId, routeRow.route, PAYLOAD_VERSION, now, now, now);
          ids.push(id);
        }
      }
      return ids;
    });
  } catch (error) {
    if (error && error.message === "publication_state_invalid") markRecommendationRecovery(storage, recommendationId, "publication_state_invalid", now);
    throw error;
  }

  const finalPath = resolveStoredRelative(layout.productRoot, row.markdown_relative_path);
  if (await hashFileSafe(finalPath) !== row.markdown_sha256) {
    markRecommendationRecovery(storage, recommendationId, "recommendation_integrity", now);
    throw new Error("recommendation_integrity");
  }
  try {
    storage.transaction(function () {
      const current = storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(row.completion_id);
      if (!current || !["OWNER_VISIBLE_AND_SCHEDULED", "ACK_PENDING", "ACKNOWLEDGED"].includes(current.state)) throw new Error("publication_state_invalid");
      storage.db.prepare("UPDATE delivery_outbox SET state='QUEUED',next_attempt_at=?,updated_at=? WHERE recommendation_id=? AND state='INTEGRITY_PENDING'").run(now, now, recommendationId);
      if (current.state === "OWNER_VISIBLE_AND_SCHEDULED") {
        const changed = storage.db.prepare("UPDATE completion_events SET state='ACK_PENDING',ack_next_at=? WHERE id=? AND state='OWNER_VISIBLE_AND_SCHEDULED'").run(now, row.completion_id);
        if (Number(changed.changes) !== 1) throw new Error("publication_state_invalid");
      }
      recordOperational(storage, "harvester", "recommendation.owner_visible", recommendationId, { routes: outboxIds.length }, now);
    });
  } catch (error) {
    if (error && error.message === "publication_state_invalid") markRecommendationRecovery(storage, recommendationId, "publication_state_invalid", now);
    throw error;
  }
  try { await wake("recommendation_published"); }
  catch { recordOperational(storage, "harvester", "dispatcher.wake_failed", recommendationId, { code: "wake_failed" }, now); }
  acknowledgeCompletion(storage, row.completion_id, now);
  return { recommendationId, outboxIds, relativePath: row.markdown_relative_path };
}

export function acknowledgeCompletion(storage, completionId, now = Date.now()) {
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(completionId);
    if (!row) throw new Error("completion_missing");
    if (row.state === "ACKNOWLEDGED") return { status: "already_acknowledged", completionId };
    if (!["ACK_PENDING", "OWNER_VISIBLE_AND_SCHEDULED"].includes(row.state)) throw new Error("completion_not_acknowledgeable");
    storage.db.prepare("UPDATE completion_events SET state='ACKNOWLEDGED',ack_attempts=ack_attempts+1,ack_next_at=NULL,acknowledged_at=? WHERE id=?").run(now, completionId);
    recordOperational(storage, "harvester", "completion.acknowledged", completionId, {}, now);
    return { status: "acknowledged", completionId };
  });
}

export async function reconcileHarvester(storage, layout, wake = function () {}, now = Date.now()) {
  const drafts = storage.db.prepare("SELECT id FROM recommendations WHERE visibility_state='DRAFT_COMMITTED' ORDER BY created_at,id").all();
  const recovered = [];
  for (const row of drafts) recovered.push(await publishRecommendation(storage, layout, row.id, wake, now));
  const pending = storage.db.prepare("SELECT DISTINCT recommendation_id FROM delivery_outbox WHERE delivery_kind='recommendation' AND state='INTEGRITY_PENDING' ORDER BY recommendation_id").all();
  for (const item of pending) {
    const row = storage.db.prepare("SELECT * FROM recommendations WHERE id=?").get(item.recommendation_id);
    let activated = false;
    try {
      const finalPath = resolveStoredRelative(layout.productRoot, row.markdown_relative_path);
      await ensureOwnedDirectory(layout.productRoot, path.dirname(finalPath));
      if (await hashFileSafe(finalPath) !== row.markdown_sha256) throw new Error("recommendation_integrity");
      storage.transaction(function () {
        const completion = storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(row.completion_id);
        if (row.visibility_state !== "OWNER_VISIBLE" || !completion || !["OWNER_VISIBLE_AND_SCHEDULED", "ACK_PENDING", "ACKNOWLEDGED"].includes(completion.state)) throw new Error("publication_state_invalid");
        storage.db.prepare("UPDATE delivery_outbox SET state='QUEUED',next_attempt_at=?,updated_at=? WHERE recommendation_id=? AND state='INTEGRITY_PENDING'").run(now, now, row.id);
        if (completion.state === "OWNER_VISIBLE_AND_SCHEDULED") {
          const changed = storage.db.prepare("UPDATE completion_events SET state='ACK_PENDING',ack_next_at=? WHERE id=? AND state='OWNER_VISIBLE_AND_SCHEDULED'").run(now, row.completion_id);
          if (Number(changed.changes) !== 1) throw new Error("publication_state_invalid");
        }
      });
      activated = true;
    } catch (error) {
      markRecommendationRecovery(storage, row.id, error && error.message === "publication_state_invalid" ? "publication_state_invalid" : "recommendation_integrity", now);
    }
    if (activated) {
      try { await wake("integrity_recovered"); }
      catch { recordOperational(storage, "harvester", "dispatcher.wake_failed", row.id, { code: "wake_failed" }, now); }
      const completion = storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(row.completion_id);
      if (completion && completion.state === "ACK_PENDING") acknowledgeCompletion(storage, row.completion_id, now);
    }
  }
  const acknowledgements = storage.db.prepare("SELECT id FROM completion_events WHERE state='ACK_PENDING' ORDER BY ack_next_at,received_at,id").all();
  for (const row of acknowledgements) acknowledgeCompletion(storage, row.id, now);
  return { publications: recovered.length, integrityRows: pending.length, acknowledgements: acknowledgements.length };
}

export function recommendationView(storage, recommendationId) {
  const row = storage.db.prepare("SELECT id,visibility_state,markdown_relative_path,canonical_json,created_at,visible_at FROM recommendations WHERE id=?").get(recommendationId);
  if (!row) return null;
  const content = JSON.parse(row.canonical_json);
  return { id: row.id, state: row.visibility_state, skillName: content.skillName, relativePath: row.markdown_relative_path, createdAt: Number(row.created_at), visibleAt: row.visible_at === null ? null : Number(row.visible_at) };
}
