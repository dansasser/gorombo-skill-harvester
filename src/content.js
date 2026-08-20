import { CONTENT_SCHEMA_VERSION, MAX_JSON_BYTES, PAYLOAD_VERSION } from "./constants.js";
import { sha256 } from "./ids.js";
import { validateStoredRelative } from "./paths.js";

const DRAFT_KEYS = new Set([
  "decision", "targetSkillRef", "targetSkillName", "extensionSummary",
  "skillName", "purpose", "whyRecommended", "whenToUse", "suggestedProcedure",
  "evidenceSummary", "proposedFiles", "resources", "overlapSummary",
  "exclusions", "nextReviewAction", "sourceRevision"
]);
const RESOURCE_KINDS = new Set(["project-file", "skill-reference", "documentation", "tool"]);
const BIDI_AND_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const TOKEN_PATTERNS = [
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/iu,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|PASSWORD|SECRET)\s*=\s*\S+/u,
  /\b(?:authorization|cookie)\s*:\s*\S+/iu
];
const ABSOLUTE_PATH_PATTERNS = [
  /(?:^|\s)[A-Za-z]:[\\/][^\s]*/u,
  /(?:^|\s)\\\\[^\s]+/u,
  /(?:^|\s)\/(?:home|root|Users|opt|etc|var|tmp)\//u
];

function scalarLength(value) {
  return Array.from(value).length;
}

function normalizeText(value, field, minimum, maximum, allowEmpty = false) {
  if (typeof value !== "string") throw new Error(field + "_invalid");
  if (value.includes("\ufffd") || BIDI_AND_CONTROLS.test(value)) throw new Error(field + "_unsafe");
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
  const length = scalarLength(normalized);
  if ((!allowEmpty && length < minimum) || length > maximum) throw new Error(field + "_invalid");
  return normalized;
}

function normalizeList(value, field, minimumItems, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) throw new Error(field + "_invalid");
  return value.map(function (item) {
    return normalizeText(item, field, 1, maximumLength);
  });
}

function rejectUnsafeString(value) {
  if (BIDI_AND_CONTROLS.test(value)) return "control_character";
  if (TOKEN_PATTERNS.some(function (pattern) { return pattern.test(value); })) return "secret_pattern";
  if (ABSOLUTE_PATH_PATTERNS.some(function (pattern) { return pattern.test(value); })) return "absolute_path";
  return null;
}

export function scanSafeContent(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      const reason = rejectUnsafeString(current);
      if (reason) return { ok: false, reason };
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === "object") {
      stack.push(...Object.values(current));
    }
  }
  return { ok: true, reason: null };
}

function validateReference(value) {
  const normalized = normalizeText(value, "resource_reference", 1, 512);
  if (/^https:\/\//iu.test(normalized)) {
    let parsed;
    try { parsed = new URL(normalized); } catch { throw new Error("resource_reference_invalid"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("resource_reference_invalid");
    return parsed.href;
  }
  return validateStoredRelative(normalized);
}

function requireExactDraftKeys(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("draft_invalid");
  for (const key of Object.keys(draft)) if (!DRAFT_KEYS.has(key)) throw new Error("draft_unknown_field");
  if (draft.decision === "extend-existing") {
    for (const required of ["targetSkillRef", "targetSkillName", "whyRecommended", "extensionSummary", "nextReviewAction"]) {
      if (!Object.hasOwn(draft, required)) throw new Error("draft_missing_field");
    }
  } else {
    for (const required of ["skillName", "purpose", "whyRecommended", "whenToUse", "suggestedProcedure", "nextReviewAction"]) {
      if (!Object.hasOwn(draft, required)) throw new Error("draft_missing_field");
    }
  }
}

export function validateDraft(draft) {
  requireExactDraftKeys(draft);
  const decision = draft.decision === "extend-existing" ? "extend-existing" : "propose-new";

  let normalized;
  if (decision === "extend-existing") {
    normalized = {
      decision: "extend-existing",
      targetSkillRef: normalizeText(draft.targetSkillRef, "target_skill_ref", 1, 200),
      targetSkillName: normalizeText(draft.targetSkillName, "target_skill_name", 1, 80),
      whyRecommended: normalizeText(draft.whyRecommended, "why_recommended", 1, 1200),
      extensionSummary: normalizeText(draft.extensionSummary, "extension_summary", 1, 1200),
      evidenceSummary: normalizeList(draft.evidenceSummary || [], "evidence_summary", 0, 6, 300),
      proposedFiles: [],
      resources: [],
      overlapSummary: "",
      exclusions: [],
      nextReviewAction: normalizeText(draft.nextReviewAction, "next_review_action", 1, 500),
      sourceRevision: draft.sourceRevision === undefined ? undefined : normalizeText(draft.sourceRevision, "source_revision", 1, 128)
    };
  } else {
    normalized = {
      decision: "propose-new",
      skillName: normalizeText(draft.skillName, "skill_name", 1, 80),
      purpose: normalizeText(draft.purpose, "purpose", 1, 500),
      whyRecommended: normalizeText(draft.whyRecommended, "why_recommended", 1, 1200),
      whenToUse: normalizeList(draft.whenToUse, "when_to_use", 1, 8, 300),
      suggestedProcedure: normalizeList(draft.suggestedProcedure, "suggested_procedure", 1, 12, 500),
      evidenceSummary: normalizeList(draft.evidenceSummary || [], "evidence_summary", 0, 6, 300),
      proposedFiles: [],
      resources: [],
      overlapSummary: normalizeText(draft.overlapSummary || "", "overlap_summary", 0, 800, true),
      exclusions: normalizeList(draft.exclusions || [], "exclusions", 0, 8, 300),
      nextReviewAction: normalizeText(draft.nextReviewAction, "next_review_action", 1, 500),
      sourceRevision: draft.sourceRevision === undefined ? undefined : normalizeText(draft.sourceRevision, "source_revision", 1, 128)
    };
  }
  if (!Array.isArray(draft.proposedFiles || []) || (draft.proposedFiles || []).length > 20) throw new Error("proposed_files_invalid");
  normalized.proposedFiles = (draft.proposedFiles || []).map(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["path", "purpose"])) throw new Error("proposed_files_invalid");
    const relativePath = validateStoredRelative(item.path);
    if (Buffer.byteLength(relativePath, "utf8") > 240) throw new Error("proposed_files_invalid");
    return { path: relativePath, purpose: normalizeText(item.purpose, "proposed_file_purpose", 1, 300) };
  });
  if (!Array.isArray(draft.resources || []) || (draft.resources || []).length > 12) throw new Error("resources_invalid");
  normalized.resources = (draft.resources || []).map(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["kind", "label", "reference"])) throw new Error("resources_invalid");
    if (!RESOURCE_KINDS.has(item.kind)) throw new Error("resources_invalid");
    return {
      kind: item.kind,
      label: normalizeText(item.label, "resource_label", 1, 100),
      reference: validateReference(item.reference)
    };
  });
  const safety = scanSafeContent(normalized);
  if (!safety.ok) throw new Error("content_unsafe_" + safety.reason);
  return Object.freeze(normalized);
}

export function finalizeRecommendation(draft, recommendationId, createdAt) {
  const normalized = validateDraft(draft);
  if (!/^rec_[0-9a-f]{32}$/u.test(recommendationId) || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("recommendation_identity_invalid");

  const content = {
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    recommendationId,
    decision: normalized.decision,
    evidenceSummary: normalized.evidenceSummary,
    proposedFiles: normalized.proposedFiles,
    resources: normalized.resources,
    overlapSummary: normalized.overlapSummary,
    exclusions: normalized.exclusions,
    nextReviewAction: normalized.nextReviewAction,
    createdAt
  };

  if (normalized.decision === "extend-existing") {
    content.targetSkillRef = normalized.targetSkillRef;
    content.targetSkillName = normalized.targetSkillName;
    content.whyRecommended = normalized.whyRecommended;
    content.extensionSummary = normalized.extensionSummary;
  } else {
    content.skillName = normalized.skillName;
    content.purpose = normalized.purpose;
    content.whyRecommended = normalized.whyRecommended;
    content.whenToUse = normalized.whenToUse;
    content.suggestedProcedure = normalized.suggestedProcedure;
  }
  if (normalized.sourceRevision !== undefined) content.sourceRevision = normalized.sourceRevision;
  const serialized = serializeCanonicalJson(content);
  if (serialized.bytes.length > MAX_JSON_BYTES) throw new Error("recommendation_too_large");
  return Object.freeze(content);
}

export function serializeCanonicalJson(content) {
  if (!content || content.contentSchemaVersion !== CONTENT_SCHEMA_VERSION || !["propose-new", "extend-existing"].includes(content.decision)) throw new Error("content_version_invalid");
  const text = JSON.stringify(content) + "\n";
  const bytes = Buffer.from(text, "utf8");
  return { text, bytes, digest: sha256(bytes) };
}

function escapeMarkdown(value) {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/gu, "\\$&");
}

function listSection(title, items, ordered = false) {
  if (items.length === 0) return "";
  return "\n## " + title + "\n\n" + items.map(function (item, index) {
    return (ordered ? String(index + 1) + ". " : "- ") + escapeMarkdown(item);
  }).join("\n") + "\n";
}

export function renderCanonicalMarkdown(content) {
  let lines = [];
  let text = "";
  if (content.decision === "extend-existing") {
    lines = [
      "# Skill extension: " + escapeMarkdown(content.targetSkillName),
      "",
      "Recommendation ID: " + escapeMarkdown(content.recommendationId),
      "",
      "## Target skill",
      "",
      escapeMarkdown(content.targetSkillRef),
      "",
      "## Why this is recommended",
      "",
      escapeMarkdown(content.whyRecommended),
      "",
      "## Extension summary",
      "",
      escapeMarkdown(content.extensionSummary)
    ];
    text = lines.join("\n") + "\n";
    text += listSection("Evidence summary", content.evidenceSummary);
  } else {
    lines = [
      "# Skill recommendation: " + escapeMarkdown(content.skillName),
      "",
      "Recommendation ID: " + escapeMarkdown(content.recommendationId),
      "",
      "## Purpose",
      "",
      escapeMarkdown(content.purpose),
      "",
      "## Why this is recommended",
      "",
      escapeMarkdown(content.whyRecommended)
    ];
    text = lines.join("\n") + "\n";
    text += listSection("When to use it", content.whenToUse);
    text += listSection("Suggested procedure", content.suggestedProcedure, true);
    text += listSection("Evidence summary", content.evidenceSummary);
  }
  if (content.proposedFiles.length > 0) text += "\n## Proposed files\n\n" + content.proposedFiles.map(function (item) {
    return "- " + escapeMarkdown(item.path) + " - " + escapeMarkdown(item.purpose);
  }).join("\n") + "\n";
  if (content.resources.length > 0) text += "\n## Resources\n\n" + content.resources.map(function (item) {
    return "- " + escapeMarkdown(item.label) + " (" + escapeMarkdown(item.kind) + "): " + escapeMarkdown(item.reference);
  }).join("\n") + "\n";
  if (content.overlapSummary) text += "\n## Overlap with existing skills\n\n" + escapeMarkdown(content.overlapSummary) + "\n";
  text += listSection("Exclusions", content.exclusions);
  text += "\n## Next review action\n\n" + escapeMarkdown(content.nextReviewAction) + "\n";
  const bytes = Buffer.from(text, "utf8");
  return { text, bytes, digest: sha256(bytes) };
}

function fullAlert(content, limits = {}) {
  let parts;
  if (content.decision === "extend-existing") {
    parts = [
      "Skill extension: " + content.targetSkillName,
      "",
      "Target skill: " + content.targetSkillRef,
      "",
      "Why: " + content.whyRecommended,
      "",
      "Extension summary: " + content.extensionSummary,
      "",
      "Next: " + content.nextReviewAction,
      "",
      "Saved recommendation: " + content.recommendationId,
      "Location: recommendations/" + content.recommendationId + ".md"
    ];
  } else {
    const triggers = content.whenToUse.slice(0, limits.triggers || content.whenToUse.length);
    const steps = content.suggestedProcedure.slice(0, limits.steps || content.suggestedProcedure.length);
    parts = [
      "Skill recommendation: " + content.skillName,
      "",
      "Purpose: " + content.purpose,
      "",
      "Why: " + content.whyRecommended,
      "",
      "Use it when:",
      ...triggers.map(function (item) { return "- " + item; }),
      "",
      "Suggested procedure:",
      ...steps.map(function (item, index) { return String(index + 1) + ". " + item; }),
      "",
      "Next: " + content.nextReviewAction,
      "",
      "Saved recommendation: " + content.recommendationId,
      "Location: recommendations/" + content.recommendationId + ".md"
    ];
  }
  return parts.join("\n");
}

function atWordBoundary(value, maximum) {
  if (scalarLength(value) <= maximum) return value;
  const cut = Array.from(value).slice(0, Math.max(1, maximum - 1)).join("");
  const boundary = cut.lastIndexOf(" ");
  return (boundary > Math.floor(maximum / 2) ? cut.slice(0, boundary) : cut).trimEnd() + "…";
}

function compactAlert(content) {
  if (content.decision === "extend-existing") {
    return [
      "Skill extension: " + content.targetSkillName,
      "Target skill: " + atWordBoundary(content.targetSkillRef, 180),
      "Why: " + atWordBoundary(content.whyRecommended, 300),
      "Summary: " + atWordBoundary(content.extensionSummary, 240),
      "Next: " + atWordBoundary(content.nextReviewAction, 240),
      "Saved: " + content.recommendationId + " at recommendations/" + content.recommendationId + ".md"
    ].join("\n");
  }
  return [
    "Skill recommendation: " + content.skillName,
    "Why: " + atWordBoundary(content.whyRecommended, 300),
    "Use when: " + atWordBoundary(content.whenToUse[0], 180),
    "First step: " + atWordBoundary(content.suggestedProcedure[0], 240),
    "Next: " + atWordBoundary(content.nextReviewAction, 240),
    "Saved: " + content.recommendationId + " at recommendations/" + content.recommendationId + ".md"
  ].join("\n");
}

export function renderDeliveryMessage(content, route, budget) {
  if (!["telegram", "session"].includes(route) || !Number.isInteger(budget) || budget < 256) throw new Error("delivery_render_invalid");
  const serialized = serializeCanonicalJson(content);
  const prefix = route === "session" ? "Gorombo Skill Harvester\n\nPlease retain this recommendation for review.\n\n" : "";
  let plainText = prefix + fullAlert(content);
  const omittedSections = [];
  if (Buffer.byteLength(plainText, "utf8") > budget) {
    omittedSections.push("optional-sections");
    let shortened = { ...content };
    if (content.decision === "extend-existing") {
      shortened.whyRecommended = atWordBoundary(content.whyRecommended, 500);
      shortened.extensionSummary = atWordBoundary(content.extensionSummary, 500);
    } else {
      shortened.purpose = atWordBoundary(content.purpose, 240);
      shortened.whyRecommended = atWordBoundary(content.whyRecommended, 500);
      shortened.whenToUse = content.whenToUse.slice(0, 3).map(function (item) { return atWordBoundary(item, 180); });
      shortened.suggestedProcedure = content.suggestedProcedure.slice(0, 5).map(function (item) { return atWordBoundary(item, 240); });
    }
    plainText = prefix + fullAlert(shortened, { triggers: 3, steps: 5 });
  }
  if (Buffer.byteLength(plainText, "utf8") > budget) {
    omittedSections.push("shortened-template");
    plainText = prefix + compactAlert(content);
  }
  if (Buffer.byteLength(plainText, "utf8") > budget) throw new Error("content_limit_too_small");
  const safety = scanSafeContent(plainText);
  if (!safety.ok) throw new Error("delivery_content_unsafe");
  return Object.freeze({
    payloadVersion: PAYLOAD_VERSION,
    recommendationId: content.recommendationId,
    route,
    title: (content.decision === "extend-existing" ? "Skill extension: " + content.targetSkillName : "Skill recommendation: " + content.skillName),
    plainText,
    canonicalContentDigest: serialized.digest,
    renderedDigest: sha256(Buffer.from(plainText, "utf8")),
    omittedSections
  });
}
