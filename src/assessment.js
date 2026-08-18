import { scanSafeContent } from "./content.js";

const REASON_CODES = /^[a-z][a-z0-9-]{0,63}$/u;

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(code);
}

function safeText(value, field, maximum) {
  if (typeof value !== "string") throw new Error(field + "_invalid");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || Array.from(normalized).length > maximum || !scanSafeContent(normalized).ok) throw new Error(field + "_invalid");
  return normalized;
}

export function validateAssessmentOutcome(outcome, catalogSnapshot) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) throw new Error("assessment_outcome_invalid");
  if (outcome.decision === "not-a-skill") {
    exactKeys(outcome, ["decision", "reasonCode", "reasonSummary"], "assessment_outcome_invalid");
    if (!REASON_CODES.test(outcome.reasonCode)) throw new Error("assessment_outcome_invalid");
    return { decision: outcome.decision, reasonCode: outcome.reasonCode, reasonSummary: safeText(outcome.reasonSummary, "reason_summary", 1200) };
  }
  if (outcome.decision === "extend-existing") {
    exactKeys(outcome, ["decision", "targetSkillRef", "targetSkillName", "reasonSummary", "extensionSummary"], "assessment_outcome_invalid");
    const match = catalogSnapshot.skills.find(function (skill) {
      return skill.skillRef === outcome.targetSkillRef && skill.valid && skill.inventoryPreferred;
    });
    if (!match || match.name !== outcome.targetSkillName) throw new Error("assessment_target_invalid");
    return {
      decision: outcome.decision,
      targetSkillRef: outcome.targetSkillRef,
      targetSkillName: outcome.targetSkillName,
      reasonSummary: safeText(outcome.reasonSummary, "reason_summary", 1200),
      extensionSummary: safeText(outcome.extensionSummary, "extension_summary", 1200)
    };
  }
  if (outcome.decision === "propose-new") {
    exactKeys(outcome, ["decision", "reasonSummary", "recommendation"], "assessment_outcome_invalid");
    if (!outcome.recommendation || outcome.recommendation.contentSchemaVersion !== 1) throw new Error("assessment_outcome_invalid");
    const draft = { ...outcome.recommendation };
    delete draft.contentSchemaVersion;
    return { decision: outcome.decision, reasonSummary: safeText(outcome.reasonSummary, "reason_summary", 1200), recommendation: draft };
  }
  throw new Error("assessment_outcome_invalid");
}

export function buildAssessmentPrompt(request) {
  const safeRequest = JSON.stringify(request);
  return [
    "Assess whether the completed work should become reusable Codex skill capability.",
    "Return only one JSON object. Do not include Markdown or commentary.",
    "Use decision not-a-skill, extend-existing, or propose-new.",
    "Choose extend-existing only for a valid preferred catalog entry.",
    "For propose-new, provide human-readable skillName, purpose, whyRecommended, whenToUse, suggestedProcedure, evidenceSummary, proposedFiles, resources, overlapSummary, exclusions, and nextReviewAction.",
    "Do not include secrets, private identities, absolute paths, raw prompts, or raw tool output.",
    "",
    safeRequest
  ].join("\n");
}
