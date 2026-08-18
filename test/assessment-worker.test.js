import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AssessmentWorker, processOneAssessment } from "../src/assessment-worker.js";
import { defaultConfig } from "../src/config.js";
import { acceptCompletion, createCompletionEvent } from "../src/harvester.js";
import { buildLayout } from "../src/paths.js";
import { openStorage } from "../src/storage.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-assessor-"));
  const codexRoot = path.join(root, "codex");
  const pluginRoot = path.join(root, "plugin");
  await fsp.mkdir(path.join(codexRoot, "skills"), { recursive: true });
  await fsp.mkdir(path.join(pluginRoot, "skills", "existing"), { recursive: true });
  await fsp.writeFile(path.join(pluginRoot, "skills", "existing", "SKILL.md"), "---\nname: existing\ndescription: Existing reusable behavior.\n---\n");
  const layout = buildLayout(codexRoot);
  await fsp.mkdir(layout.recommendationsDir, { recursive: true });
  const storage = openStorage(":memory:", { create: true, now: 1000 });
  storage.upsertRoute("telegram", true, "READY", {}, 1000);
  const event = createCompletionEvent({
    taskId: "task",
    generation: 1,
    completedAt: 1000,
    sourceRevision: "rev",
    evidence: [{ kind: "user_request", text: "Create a repeatable release checklist." }]
  });
  acceptCompletion(storage, event, 1000);
  return { root, codexRoot, pluginRoot, layout, storage };
}

test("assessment cycle publishes a useful recommendation and directly queues delivery", async function () {
  const x = await fixture();
  try {
    let wakes = 0;
    const result = await processOneAssessment({
      storage: x.storage,
      layout: x.layout,
      pluginRoot: x.pluginRoot,
      config: defaultConfig("telegram"),
      workerId: "worker",
      now: 1000,
      clock: { now: function () { return 1001; } },
      assess: async function () {
        return {
          decision: "propose-new",
          reasonSummary: "The completed work is repeatable.",
          recommendation: {
            contentSchemaVersion: 1,
            skillName: "release-checklist",
            purpose: "Build and verify repeatable release checklists.",
            whyRecommended: "The procedure has reusable steps and objective verification.",
            whenToUse: ["When preparing a public package release."],
            suggestedProcedure: ["Inspect the package.", "Run verification.", "Record safe evidence."],
            evidenceSummary: ["A repeatable checklist was requested and verified."],
            proposedFiles: [{ path: "SKILL.md", purpose: "Describe the reusable workflow." }],
            resources: [],
            overlapSummary: "No existing skill fully covers the workflow.",
            exclusions: ["Do not publish credentials."],
            nextReviewAction: "Review the recommendation and approve skill development."
          }
        };
      },
      wakeDeliveries: async function () { wakes += 1; }
    });
    assert.equal(result.status, "committed");
    assert.equal(result.decision, "propose-new");
    const recommendation = x.storage.db.prepare("SELECT visibility_state,markdown_relative_path FROM recommendations").get();
    assert.equal(recommendation.visibility_state, "OWNER_VISIBLE");
    assert.match(recommendation.markdown_relative_path, /^recommendations\/rec_[a-f0-9]{32}\.md$/u);
    assert.equal(x.storage.db.prepare("SELECT state FROM delivery_outbox").get().state, "QUEUED");
    assert.equal(wakes, 1);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("required catalog failure releases the claim without invoking assessor", async function () {
  const x = await fixture();
  try {
    const config = defaultConfig("telegram");
    config.harvester.catalogRoots[0].relativePath = "missing-skills";
    let invoked = false;
    const result = await processOneAssessment({
      storage: x.storage,
      layout: x.layout,
      pluginRoot: x.pluginRoot,
      config,
      workerId: "worker",
      now: 1000,
      clock: { now: function () { return 1001; } },
      assess: async function () { invoked = true; }
    });
    assert.equal(result.status, "retry");
    assert.equal(result.code, "catalog_incomplete");
    assert.equal(invoked, false);
    const row = x.storage.db.prepare("SELECT state,assessment_lease_token,assessment_next_at FROM completion_events").get();
    assert.equal(row.state, "ASSESSMENT_PENDING");
    assert.equal(row.assessment_lease_token, null);
    assert.ok(Number(row.assessment_next_at) > 1001);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});


test("publication failure after assessment commit is not reported as reassessment retry", async function () {
  const x = await fixture();
  try {
    const outcome = {
      decision: "propose-new",
      reasonSummary: "The completed work is repeatable.",
      recommendation: {
        contentSchemaVersion: 1,
        skillName: "release-checklist",
        purpose: "Build and verify repeatable release checklists.",
        whyRecommended: "The procedure has reusable steps and objective verification.",
        whenToUse: ["When preparing a public package release."],
        suggestedProcedure: ["Inspect the package.", "Run verification.", "Record safe evidence."],
        evidenceSummary: ["A repeatable checklist was requested and verified."],
        proposedFiles: [{ path: "SKILL.md", purpose: "Describe the reusable workflow." }],
        resources: [],
        overlapSummary: "No existing skill fully covers the workflow.",
        exclusions: ["Do not publish credentials."],
        nextReviewAction: "Review the recommendation and approve skill development."
      }
    };
    const result = await processOneAssessment({
      storage: x.storage,
      layout: x.layout,
      pluginRoot: x.pluginRoot,
      config: defaultConfig("telegram"),
      workerId: "worker",
      now: 1000,
      clock: { now: function () { return 1001; } },
      assess: async function () { return outcome; },
      publish: async function () { throw new Error("publication_unavailable"); }
    });
    assert.equal(result.status, "publication_pending");
    assert.equal(result.code, "publication_unavailable");
    const completion = x.storage.db.prepare("SELECT state,assessment_lease_token FROM completion_events").get();
    assert.equal(completion.state, "PUBLICATION_PENDING");
    assert.equal(completion.assessment_lease_token, null);
    assert.equal(x.storage.db.prepare("SELECT COUNT(*) AS count FROM assessments").get().count, 1);
    let reassessed = false;
    const next = await processOneAssessment({
      storage: x.storage,
      layout: x.layout,
      pluginRoot: x.pluginRoot,
      config: defaultConfig("telegram"),
      workerId: "worker",
      now: 1002,
      assess: async function () { reassessed = true; return outcome; }
    });
    assert.equal(next.status, "idle");
    assert.equal(reassessed, false);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});

test("assessment worker stop returns after bounded grace when assessor ignores abort", async function () {
  const x = await fixture();
  let resolveStarted;
  const started = new Promise(function (resolve) { resolveStarted = resolve; });
  const worker = new AssessmentWorker({
    storage: x.storage,
    layout: x.layout,
    pluginRoot: x.pluginRoot,
    config: defaultConfig("telegram"),
    workerId: "worker",
    stopGraceMs: 20,
    assess: async function () {
      resolveStarted();
      return await new Promise(function () {});
    }
  });
  try {
    worker.start();
    await started;
    const before = Date.now();
    const result = await worker.stop();
    assert.equal(result.graceExpired, true);
    assert.ok(Date.now() - before < 500);
    const row = x.storage.db.prepare("SELECT state,assessment_lease_token FROM completion_events").get();
    assert.equal(row.state, "ASSESSMENT_PENDING");
    assert.notEqual(row.assessment_lease_token, null);
  } finally {
    x.storage.close();
    await fsp.rm(x.root, { recursive: true, force: true });
  }
});
