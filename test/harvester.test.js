import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCatalogSnapshot } from "../src/catalog.js";
import { openStorage } from "../src/storage.js";
import { acceptCompletion, claimAssessment, createCompletionEvent, persistCatalogSnapshot, publishRecommendation, reconcileHarvester, recordAssessment, releaseAssessmentClaim } from "../src/harvester.js";
import { buildLayout } from "../src/paths.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-core-"));
  const codexRoot = path.join(root, "codex");
  const pluginRoot = path.join(root, "plugin");
  await fsp.mkdir(path.join(codexRoot, "skills", "example"), { recursive: true });
  await fsp.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
  await fsp.writeFile(path.join(codexRoot, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Existing example capability.\n---\n", "utf8");
  const layout = buildLayout(codexRoot);
  await fsp.mkdir(layout.recommendationsDir, { recursive: true });
  const storage = openStorage(":memory:", { create: true, now: 1 });
  storage.upsertRoute("telegram", true, "READY", {}, 1);
  return { root, codexRoot, pluginRoot, layout, storage };
}

function event() {
  return createCompletionEvent({
    taskId: "task-one",
    generation: 0,
    completedAt: 100,
    sourceRevision: "release-one",
    evidence: [
      { kind: "user_request", text: "Create repeatable release verification." },
      { kind: "agent_result", text: "The same bounded checks were applied successfully." }
    ]
  });
}

test("completion replay is idempotent and digest conflict fails closed", async function () {
  const x = await fixture();
  try {
    const first = acceptCompletion(x.storage, event(), 101);
    const second = acceptCompletion(x.storage, event(), 102);
    assert.equal(first.status, "accepted_new");
    assert.equal(second.status, "accepted_existing");
    const bad = { ...event(), completionEvidenceDigest: "0".repeat(64) };
    assert.throws(function () { acceptCompletion(x.storage, bad, 103); }, /completion_digest_mismatch/);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("propose-new becomes owner visible and directly queues a readable alert", async function () {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([
      { anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 },
      { anchor: "plugin-root", relativePath: "skills", origin: "plugin", precedence: 200 }
    ], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const claim = claimAssessment(x.storage, "worker-one", 103);
    assert.equal(claim.completionId, intake.completionId);
    const assessment = recordAssessment(x.storage, claim, catalog, {
      decision: "propose-new",
      reasonSummary: "The completed work is reusable.",
      recommendation: {
        contentSchemaVersion: 1,
        skillName: "Release verifier",
        purpose: "Verify release candidates consistently.",
        whyRecommended: "The same release checks recur across tasks.",
        whenToUse: ["A release candidate needs verification."],
        suggestedProcedure: ["Collect the declared artifacts.", "Verify hashes and health."],
        evidenceSummary: ["The completed work repeated a stable verification sequence."],
        proposedFiles: [{ path: "skills/release-verifier/SKILL.md", purpose: "Reusable instructions." }],
        resources: [],
        overlapSummary: "The existing example skill does not own release gates.",
        exclusions: ["Do not publish automatically."],
        nextReviewAction: "Review and approve, revise, or reject this recommendation."
      }
    }, "test-assessment-v1", 104);
    let wakes = 0;
    const publication = await publishRecommendation(x.storage, x.layout, assessment.recommendationId, function () { wakes += 1; }, 105);
    assert.equal(wakes, 1);
    assert.equal(publication.outboxIds.length, 1);
    const completion = x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId);
    const recommendation = x.storage.db.prepare("SELECT visibility_state,markdown_relative_path FROM recommendations WHERE id=?").get(assessment.recommendationId);
    const outbox = x.storage.db.prepare("SELECT state,route FROM delivery_outbox WHERE recommendation_id=?").get(assessment.recommendationId);
    assert.equal(completion.state, "ACKNOWLEDGED");
    assert.equal(recommendation.visibility_state, "OWNER_VISIBLE");
    assert.equal(outbox.state, "QUEUED");
    assert.equal(outbox.route, "telegram");
    const markdown = await fsp.readFile(path.join(x.layout.productRoot, ...recommendation.markdown_relative_path.split("/")), "utf8");
    assert.match(markdown, /# Skill recommendation: Release verifier/);
    assert.match(markdown, /## Next review action/);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("extend-existing commits the preferred skill reference with recommendation and alert", async function () {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const target = catalog.snapshot.skills[0];
    const extensionSummary = "Add the bounded release-verification procedure to this skill.";
    const claim = claimAssessment(x.storage, "worker-one", 103);
    const result = recordAssessment(x.storage, claim, catalog, {
      decision: "extend-existing",
      targetSkillRef: target.skillRef,
      targetSkillName: target.name,
      reasonSummary: "The existing example capability should cover this repeated work.",
      extensionSummary
    }, "test", 104);
    assert.equal(result.decision, "extend-existing");
    assert.notEqual(result.recommendationId, null);
    assert.equal(result.completionId, intake.completionId);
    const assessment = x.storage.db.prepare(
      "SELECT decision,target_skill_ref,target_skill_name,extension_summary,recommendation_id,recommendation_json,recommendation_digest FROM assessments WHERE completion_id=?"
    ).get(intake.completionId);
    assert.equal(assessment.decision, "extend-existing");
    assert.equal(assessment.target_skill_ref, target.skillRef);
    assert.equal(assessment.target_skill_name, target.name);
    assert.equal(assessment.extension_summary, extensionSummary);
    assert.equal(assessment.recommendation_id, result.recommendationId);
    assert.notEqual(assessment.recommendation_json, null);
    assert.notEqual(assessment.recommendation_digest, null);

    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId).state, "PUBLICATION_PENDING");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM recommendations").get().n, 1);

    let wakes = 0;
    const publication = await publishRecommendation(x.storage, x.layout, assessment.recommendation_id, function () { wakes += 1; }, 105);
    assert.equal(wakes, 1);
    assert.equal(publication.outboxIds.length, 1);
    const completion = x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId);
    const recommendation = x.storage.db.prepare("SELECT visibility_state,markdown_relative_path FROM recommendations WHERE id=?").get(assessment.recommendation_id);
    const outbox = x.storage.db.prepare("SELECT state,route FROM delivery_outbox WHERE recommendation_id=?").get(assessment.recommendation_id);

    assert.equal(completion.state, "ACKNOWLEDGED");
    assert.equal(recommendation.visibility_state, "OWNER_VISIBLE");
    assert.equal(outbox.state, "QUEUED");
    assert.equal(outbox.route, "telegram");

    const markdown = await fsp.readFile(path.join(x.layout.productRoot, ...recommendation.markdown_relative_path.split("/")), "utf8");
    assert.match(markdown, /# Skill extension: /);
    assert.match(markdown, new RegExp(target.name));
    assert.match(markdown, /## Extension summary/);
    assert.match(markdown, /Add the bounded release\\-verification procedure to this skill/);
    assert.match(markdown, /## Next review action/);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("not-a-skill commits once without recommendation or alert", async function () {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const claim = claimAssessment(x.storage, "worker-one", 103);
    recordAssessment(x.storage, claim, catalog, { decision: "not-a-skill", reasonCode: "one-off-task", reasonSummary: "This completion is specific to one request." }, "test", 104);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId).state, "ACKNOWLEDGED");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM recommendations").get().n, 0);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 0);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});


test("assessment leases are expiry-fenced and retries exhaust after five attempts", async function () {
  const x = await fixture();
  try {
    acceptCompletion(x.storage, event(), 100);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 101);
    persistCatalogSnapshot(x.storage, catalog, 101);
    const expired = claimAssessment(x.storage, "expired-worker", 102);
    assert.throws(function () {
      recordAssessment(x.storage, expired, catalog, { decision: "not-a-skill", reasonCode: "one-off-task", reasonSummary: "One-off." }, "test", expired.leaseExpiresAt);
    }, /assessment_claim_stale/);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM assessments").get().n, 0);
    assert.equal(claimAssessment(x.storage, "worker", expired.leaseExpiresAt), null);
    let now = expired.leaseExpiresAt + 5000;
    let claim = claimAssessment(x.storage, "worker", now);
    assert.equal(claim.attemptNumber, 2);
    for (let attempt = 2; attempt < 5; attempt += 1) {
      assert.equal(releaseAssessmentClaim(x.storage, claim, "temporary_failure", now + 1), true);
      const due = Number(x.storage.db.prepare("SELECT assessment_next_at FROM completion_events").get().assessment_next_at);
      claim = claimAssessment(x.storage, "worker", due);
      assert.equal(claim.attemptNumber, attempt + 1);
      now = due;
    }
    assert.equal(releaseAssessmentClaim(x.storage, claim, "temporary_failure", now + 1), true);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events").get().state, "RECOVERY_REQUIRED");
    assert.equal(claimAssessment(x.storage, "worker", now + 1_000_000), null);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("publication state mismatch rolls back fan-out and enters recovery", async function () {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const claim = claimAssessment(x.storage, "worker", 103);
    const result = recordAssessment(x.storage, claim, catalog, {
      decision: "propose-new",
      reasonSummary: "Reusable.",
      recommendation: {
        contentSchemaVersion: 1,
        skillName: "State verifier",
        purpose: "Verify state transitions.",
        whyRecommended: "The checks recur.",
        whenToUse: ["State must be verified."],
        suggestedProcedure: ["Verify the state."],
        evidenceSummary: [],
        proposedFiles: [],
        resources: [],
        overlapSummary: "",
        exclusions: [],
        nextReviewAction: "Review it."
      }
    }, "test", 104);
    x.storage.db.prepare("UPDATE completion_events SET state='RECOVERY_REQUIRED' WHERE id=?").run(intake.completionId);
    await assert.rejects(publishRecommendation(x.storage, x.layout, result.recommendationId, function () {}, 105), /publication_state_invalid/);
    assert.equal(x.storage.db.prepare("SELECT visibility_state FROM recommendations WHERE id=?").get(result.recommendationId).visibility_state, "RECOVERY_REQUIRED");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 0);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("wake failure does not block acknowledgement and restart reconciles ACK_PENDING", async function () {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const claim = claimAssessment(x.storage, "worker", 103);
    const result = recordAssessment(x.storage, claim, catalog, {
      decision: "propose-new",
      reasonSummary: "Reusable.",
      recommendation: {
        contentSchemaVersion: 1,
        skillName: "Wake verifier",
        purpose: "Verify wake recovery.",
        whyRecommended: "Wake recovery matters.",
        whenToUse: ["A durable queue is woken."],
        suggestedProcedure: ["Wake and reconcile."],
        evidenceSummary: [],
        proposedFiles: [],
        resources: [],
        overlapSummary: "",
        exclusions: [],
        nextReviewAction: "Review it."
      }
    }, "test", 104);
    await publishRecommendation(x.storage, x.layout, result.recommendationId, function () { throw new Error("wake failed"); }, 105);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId).state, "ACKNOWLEDGED");
    x.storage.db.prepare("UPDATE completion_events SET state='ACK_PENDING',ack_next_at=? WHERE id=?").run(106, intake.completionId);
    const before = x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n;
    const reconciled = await reconcileHarvester(x.storage, x.layout, function () {}, 107);
    assert.equal(reconciled.acknowledgements, 1);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId).state, "ACKNOWLEDGED");
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, before);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("recommendation publication rejects a redirected owned directory", async function (t) {
  const x = await fixture();
  try {
    const intake = acceptCompletion(x.storage, event(), 101);
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 }], { codexRoot: x.codexRoot, pluginRoot: x.pluginRoot }, 102);
    persistCatalogSnapshot(x.storage, catalog, 102);
    const claim = claimAssessment(x.storage, "worker", 103);
    const result = recordAssessment(x.storage, claim, catalog, {
      decision: "propose-new",
      reasonSummary: "Reusable.",
      recommendation: {
        contentSchemaVersion: 1,
        skillName: "Path verifier",
        purpose: "Verify safe publication paths.",
        whyRecommended: "Publication paths need containment.",
        whenToUse: ["A recommendation is published."],
        suggestedProcedure: ["Verify every owned parent."],
        evidenceSummary: [],
        proposedFiles: [],
        resources: [],
        overlapSummary: "",
        exclusions: [],
        nextReviewAction: "Review it."
      }
    }, "test", 104);
    const outside = path.join(x.root, "outside");
    await fsp.mkdir(outside);
    await fsp.rm(x.layout.recommendationsDir, { recursive: true });
    try { await fsp.symlink(outside, x.layout.recommendationsDir, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (error && ["EPERM", "EACCES"].includes(error.code)) return t.skip("link creation unavailable"); throw error; }
    await assert.rejects(publishRecommendation(x.storage, x.layout, result.recommendationId, function () {}, 105), /owned_path_unsafe/);
    assert.equal(x.storage.db.prepare("SELECT state FROM completion_events WHERE id=?").get(intake.completionId).state, "RECOVERY_REQUIRED");
    assert.deepEqual(await fsp.readdir(outside), []);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});
