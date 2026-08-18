import { buildAssessmentPrompt, validateAssessmentOutcome } from "./assessment.js";
import { runCodexTask } from "./codex-process.js";

const MAX_ASSESSMENT_RESPONSE_BYTES = 64 * 1024;

export function buildAssessmentRequest(claim, catalog) {
  return {
    schemaVersion: 1,
    correlationKey: claim.correlationKey,
    assessmentVersion: "harvester-assessment-v1",
    safeEvidence: claim.safeEvidence,
    safeEvidenceDigest: claim.safeEvidenceDigest,
    catalogRevision: catalog.revision,
    catalogEntries: catalog.snapshot.skills.filter(function (skill) {
      return skill.valid && skill.inventoryPreferred;
    }).map(function (skill) {
      return {
        skillRef: skill.skillRef,
        name: skill.name,
        description: skill.description,
        triggerSummary: skill.description,
        packageLocation: skill.relativeSkillPath
      };
    })
  };
}

export function parseAssessmentResponse(text, catalogSnapshot) {
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_ASSESSMENT_RESPONSE_BYTES) throw new Error("assessment_response_invalid");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("assessment_response_invalid"); }
  return validateAssessmentOutcome(value, catalogSnapshot);
}

export async function runAssessment(options) {
  const request = buildAssessmentRequest(options.claim, options.catalog);
  const prompt = buildAssessmentPrompt(request);
  const run = options.runTask || runCodexTask;
  const result = await run({
    prompt,
    cwd: options.pluginRoot,
    sandbox: "read-only",
    executable: options.executable,
    launchPlan: options.launchPlan,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs || 90_000
  });
  if (!result || result.ok !== true) {
    const category = result && typeof result.category === "string" ? result.category : "execution";
    throw new Error("assessment_" + (/^[a-z_]+$/u.test(category) ? category : "execution"));
  }
  return parseAssessmentResponse(result.resultText, options.catalog.snapshot);
}
