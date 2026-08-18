import assert from "node:assert/strict";
import test from "node:test";
import { finalizeRecommendation, renderCanonicalMarkdown, renderDeliveryMessage, scanSafeContent, serializeCanonicalJson, validateDraft } from "../src/content.js";

const draft = {
  skillName: "Release verifier",
  purpose: "Verify a release before it is announced.",
  whyRecommended: "The same bounded checks were needed across several completed tasks.",
  whenToUse: ["A release candidate needs objective verification."],
  suggestedProcedure: ["Collect the declared release artifacts.", "Verify hashes and health checks."],
  evidenceSummary: ["Repeated release checks followed the same safe procedure."],
  proposedFiles: [{ path: "skills/release-verifier/SKILL.md", purpose: "Reusable verification workflow." }],
  resources: [{ kind: "documentation", label: "Release policy", reference: "docs/release-policy.md" }],
  overlapSummary: "No installed skill owns the complete release gate.",
  exclusions: ["Do not publish the release."],
  nextReviewAction: "Review the proposal and approve, revise, or reject it.",
  sourceRevision: "abc123"
};

test("draft validation rejects unknown and unsafe content", function () {
  assert.equal(validateDraft(draft).skillName, "Release verifier");
  assert.throws(function () { validateDraft({ ...draft, unknown: true }); }, /draft_unknown_field/);
  assert.equal(scanSafeContent("TELEGRAM_BOT_TOKEN=secret-value").ok, false);
  assert.throws(function () { validateDraft({ ...draft, purpose: "Read C:\\Users\\person\\secret.txt" }); }, /content_unsafe/);
});

test("canonical recommendation and Markdown are deterministic", function () {
  const content = finalizeRecommendation(draft, "rec_0123456789abcdef0123456789abcdef", 1234);
  const one = serializeCanonicalJson(content);
  const two = serializeCanonicalJson(content);
  assert.equal(one.digest, two.digest);
  const markdown = renderCanonicalMarkdown(content);
  assert.match(markdown.text, /^# Skill recommendation: Release verifier/m);
  assert.match(markdown.text, /## Why this is recommended/);
  assert.match(markdown.text, /Recommendation ID: rec\\_0123456789abcdef0123456789abcdef/);
});

test("delivery is human-readable and preserves required meaning", function () {
  const content = finalizeRecommendation(draft, "rec_0123456789abcdef0123456789abcdef", 1234);
  const message = renderDeliveryMessage(content, "telegram", 4096);
  assert.match(message.plainText, /Skill recommendation: Release verifier/);
  assert.match(message.plainText, /Why:/);
  assert.match(message.plainText, /Use it when:/);
  assert.match(message.plainText, /Suggested procedure:/);
  assert.match(message.plainText, /Location: recommendations\/rec_/);
  assert.doesNotMatch(message.plainText, /^\{/);
});

test("delivery compacts or rejects without raw truncation", function () {
  const large = { ...draft, whyRecommended: "reason ".repeat(150), purpose: "purpose ".repeat(55) };
  const content = finalizeRecommendation(large, "rec_0123456789abcdef0123456789abcdef", 1234);
  const compact = renderDeliveryMessage(content, "telegram", 800);
  assert.ok(Buffer.byteLength(compact.plainText, "utf8") <= 800);
  assert.throws(function () { renderDeliveryMessage(content, "telegram", 256); }, /content_limit_too_small/);
});
