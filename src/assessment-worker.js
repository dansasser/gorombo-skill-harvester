import { buildCatalogSnapshot } from "./catalog.js";
import { claimAssessment, persistCatalogSnapshot, publishRecommendation, recordAssessment, recoverExpiredAssessmentLeases, releaseAssessmentClaim } from "./harvester.js";
import { runAssessment } from "./assessment-runner.js";

function nextAssessmentDueAt(storage) {
  const row = storage.db.prepare(
    "SELECT MIN(due_at) AS due_at FROM (" +
    "SELECT assessment_next_at AS due_at FROM completion_events WHERE state='ASSESSMENT_PENDING' AND assessment_lease_token IS NULL " +
    "UNION ALL SELECT assessment_lease_expires_at AS due_at FROM completion_events WHERE state='ASSESSMENT_PENDING' AND assessment_lease_token IS NOT NULL)"
  ).get();
  return row && row.due_at !== null ? Number(row.due_at) : null;
}
function safeAssessmentCode(error) {
  const value = String(error && error.message || "assessment_failed");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "assessment_failed";
}

export async function processOneAssessment(options) {
  const now = options.now === undefined ? Date.now() : options.now;
  const claim = claimAssessment(options.storage, options.workerId, now);
  if (!claim) return { status: "idle" };
  let result;
  try {
    const catalog = await buildCatalogSnapshot(options.config.harvester.catalogRoots, {
      codexRoot: options.layout.codexRoot,
      pluginRoot: options.pluginRoot
    }, now);
    if (catalog.snapshot.rootErrors.length > 0) {
      releaseAssessmentClaim(options.storage, claim, "catalog_incomplete", options.clock ? options.clock.now() : Date.now());
      return { status: "retry", code: "catalog_incomplete" };
    }
    persistCatalogSnapshot(options.storage, catalog, now);
    const outcome = await (options.assess || runAssessment)({
      claim,
      catalog,
      pluginRoot: options.pluginRoot,
      executable: options.executable,
      launchPlan: options.launchPlan,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    const committedAt = options.clock ? options.clock.now() : Date.now();
    result = recordAssessment(options.storage, claim, catalog, outcome, "harvester-assessment-v1", committedAt);
  } catch (error) {
    const failureAt = options.clock ? options.clock.now() : Date.now();
    try { releaseAssessmentClaim(options.storage, claim, safeAssessmentCode(error), failureAt); }
    catch {}
    return { status: "retry", code: safeAssessmentCode(error) };
  }
  if (result.recommendationId) {
    const publicationAt = options.clock ? options.clock.now() : Date.now();
    try {
      await (options.publish || publishRecommendation)(options.storage, options.layout, result.recommendationId, options.wakeDeliveries || function () {}, publicationAt);
    } catch (error) {
      return {
        status: "publication_pending",
        decision: result.decision,
        recommendationId: result.recommendationId,
        code: safeAssessmentCode(error)
      };
    }
  }
  return { status: "committed", decision: result.decision, recommendationId: result.recommendationId };
}

export class AssessmentWorker {
  constructor(options) {
    this.options = options;
    this.storage = options.storage;
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.workerId = options.workerId || "assessment-runtime";
    this.running = false;
    this.timer = null;
    this.pumpPromise = null;
    this.wakeAgain = false;
    this.activeAbort = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    recoverExpiredAssessmentLeases(this.storage, this.clock.now());
    this.wake();
  }

  wake() {
    if (!this.running) return;
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
        recoverExpiredAssessmentLeases(this.storage, this.clock.now());
        while (this.running) {
          const controller = new AbortController();
          this.activeAbort = controller;
          const result = await processOneAssessment({
            ...this.options,
            storage: this.storage,
            workerId: this.workerId,
            now: this.clock.now(),
            clock: this.clock,
            signal: controller.signal
          });
          this.activeAbort = null;
          if (result.status === "idle") break;
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
    const due = nextAssessmentDueAt(this.storage);
    if (due === null) return;
    const delay = Math.max(0, Math.min(2_147_483_647, due - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.wake();
    }, delay);
  }

  async stop() {
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.activeAbort) this.activeAbort.abort();
    if (!this.pumpPromise) return { status: "stopped", graceExpired: false };
    const graceMs = this.options.stopGraceMs === undefined ? 5000 : this.options.stopGraceMs;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 60_000) throw new Error("assessment_stop_grace_invalid");
    let timer = null;
    const completed = await Promise.race([
      this.pumpPromise.then(function () { return true; }, function () { return true; }),
      new Promise((resolve) => {
        timer = this.clock.setTimeout(function () { resolve(false); }, graceMs);
      })
    ]);
    if (timer !== null && completed) this.clock.clearTimeout(timer);
    return { status: "stopped", graceExpired: !completed };
  }
}
