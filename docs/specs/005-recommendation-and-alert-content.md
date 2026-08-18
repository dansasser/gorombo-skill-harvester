# SDD 005: Recommendation and alert content

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester content boundary
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: canonical recommendation schema, human-readable Markdown, safe evidence summaries, route-neutral alerts, destination limits, truncation, and non-propose notification policy
- Approval blockers: the mandatory schema and proposed extend-existing no-alert default require product-owner approval

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification implements MSG-001, MSG-002, and MSG-003.

It owns ACC-017 and the content portions of ACC-015, ACC-016, ACC-018, ACC-021, and ACC-035.

Confirmed behavior:

1. Alerts use useful words, not raw internal JSON and not digest-only payloads.
2. A proposed-new alert states the skill name, why it is recommended, when it applies, and the suggested procedure.
3. Content is rendered from an explicit safe bounded model.
4. The stored recommendation is the source for route messages.
5. Route formatting may shorten content but must preserve the name and actionable meaning.
6. Private evidence and secrets are excluded or safely summarized.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Define exactly what a proposed skill recommendation contains, how it is normalized and persisted as readable Markdown, and how safe route messages are derived without exposing internal objects or private evidence.

### 3.2 Goals

- Produce alerts a user can understand and act on immediately.
- Keep one canonical safe content model.
- Make Markdown deterministic and digestible.
- Preserve the proposed name and actionable meaning in every destination.
- Bound every field and list.
- Give route adapters a deterministic shortening contract.
- Reject unsafe payloads instead of stringifying them.
- Identify the stable recommendation and saved relative location.

### 3.3 Non-goals

- Telegram HTML or Bot API request details.
- Codex App Server turn request details.
- Delivery retry or receipt behavior.
- Producing skill source files automatically.
- Attaching raw transcripts, prompts, tool output, tokens, or absolute paths.
- Choosing a public package name.

## 4. Terminology

- Canonical recommendation: validated content object stored for one proposed-new result.
- Canonical JSON: normalized serialized content used for database identity.
- Canonical Markdown: deterministic owner-visible document rendered from canonical content.
- Safe evidence summary: short derived statement with sensitive and irrelevant details removed.
- Route-neutral alert: plain structured message before provider formatting.
- Required meaning: skill name, why, at least one use trigger, at least one procedure step, stable record ID, and next action.
- Payload version: renderer contract version stored in the outbox.
- Destination budget: provider-supplied maximum measured by its documented unit.
- Omission marker: human-readable statement that more detail is in the saved recommendation.
- Unsafe payload: object not produced by the content validator or containing a prohibited value.

## 5. Actors and journeys

- Assessor proposes a typed draft through SDD 003.
- Content validator normalizes, bounds, and rejects unsafe values.
- Storage adds recommendation ID and time, persists canonical JSON, and publishes Markdown.
- Delivery renderer loads the owner-visible recommendation by ID.
- Telegram formatter in SDD 007 escapes and sends the route-neutral text.
- Session formatter in SDD 009 identifies the recommendation and submits a turn.
- User reads the alert and can open the saved recommendation for full detail.

No route accepts an arbitrary object from a caller. The only route entry is renderDeliveryMessage(recommendationId, route, payloadVersion, budget).

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 CanonicalRecommendation version 1

~~~json
{
  "contentSchemaVersion": 1,
  "recommendationId": "rec_32-lowercase-hex",
  "decision": "propose-new",
  "skillName": "Descriptive public name",
  "purpose": "What the skill should do.",
  "whyRecommended": "Why this should become reusable capability.",
  "whenToUse": ["A concrete trigger."],
  "suggestedProcedure": ["An ordered implementation or use step."],
  "evidenceSummary": ["A safe derived observation."],
  "proposedFiles": [
    {"path": "skills/example/SKILL.md", "purpose": "Skill entry instructions."}
  ],
  "resources": [
    {"kind": "project-file", "label": "Existing reference", "reference": "docs/example.md"}
  ],
  "overlapSummary": "How this differs from existing skills.",
  "exclusions": ["What the skill should not do."],
  "nextReviewAction": "Review and approve the recommendation.",
  "createdAt": 0,
  "sourceRevision": "optional-safe-revision"
}
~~~

### 6.2 Required fields and bounds

| Field | Rule |
|---|---|
| contentSchemaVersion | Integer exactly 1 |
| recommendationId | Valid SDD 004 rec_ ID |
| decision | Exactly propose-new |
| skillName | 1 to 80 Unicode scalar values |
| purpose | 1 to 500 scalar values |
| whyRecommended | 1 to 1200 scalar values |
| whenToUse | 1 to 8 strings, each 1 to 300 scalar values |
| suggestedProcedure | 1 to 12 strings, each 1 to 500 scalar values |
| evidenceSummary | 0 to 6 strings, each 1 to 300 scalar values |
| proposedFiles | 0 to 20 objects |
| proposedFiles.path | Project-relative, 1 to 240 UTF-8 bytes, SDD 002 validation |
| proposedFiles.purpose | 1 to 300 scalar values |
| resources | 0 to 12 objects |
| resources.kind | project-file, skill-reference, documentation, or tool |
| resources.label | 1 to 100 scalar values |
| resources.reference | 1 to 512 scalar values; safe relative reference or approved public HTTPS URI |
| overlapSummary | 0 to 800 scalar values |
| exclusions | 0 to 8 strings, each 1 to 300 scalar values |
| nextReviewAction | 1 to 500 scalar values |
| createdAt | Nonnegative UTC Unix milliseconds |
| sourceRevision | Absent or 1 to 128 safe scalar values |

Total canonical JSON is at most 64 KiB. Unknown fields, duplicate object keys, non-finite numbers, unsupported URI schemes, URI credentials, URI query tokens, absolute file paths, and control characters other than normalized whitespace fail.

### 6.3 Route-neutral output

~~~json
{
  "payloadVersion": 1,
  "recommendationId": "rec_...",
  "route": "telegram",
  "title": "Skill recommendation: Descriptive public name",
  "plainText": "Human-readable bounded message",
  "canonicalContentDigest": "64-hex",
  "renderedDigest": "64-hex",
  "omittedSections": []
}
~~~

The delivery envelope contains no raw recommendation JSON, evidence object, secret, private identity, or absolute path.

### 6.4 Preconditions and postconditions

Preconditions: recommendation is OWNER_VISIBLE; database digest and Markdown digest agree; requested payloadVersion is supported; budget and measure function come from the route adapter.

Postconditions: output passes safe-output validation, fits the budget, includes required meaning, identifies the stable record, and is deterministic for the same inputs.

## 7. APIs, commands, events, and formats

### 7.1 Content APIs

~~~text
validateDraft(draft) -> ValidatedDraft | ContentError
finalizeRecommendation(draft, id, createdAt) -> CanonicalRecommendation
serializeCanonicalJson(content) -> bytes and digest
renderCanonicalMarkdown(content) -> bytes and digest
renderDeliveryMessage(id, route, payloadVersion, budget) -> DeliveryEnvelope
scanSafeContent(value) -> SafetyResult
~~~

### 7.2 Read operations

- gorombo-skill-harvester recommendation show RECOMMENDATION_ID
- gorombo-skill-harvester recommendation list --decision propose-new
- gorombo-skill-harvester recommendation path RECOMMENDATION_ID

Output uses the stored content and product-root-relative location. A command does not expose raw evidence.

### 7.3 Stable events

content.validated, content.rejected, recommendation.rendered, alert.rendered, alert.shortened, and alert.rejected. Events carry IDs, versions, digests, omitted section names, and safe reason codes.

## 8. Exact data and file formats

### 8.1 Normalization

- Input strings are normalized to Unicode NFC.
- CRLF and CR become LF before field normalization.
- Field-internal runs of whitespace become one space except no whitespace is added across intentional list items.
- Leading and trailing whitespace is removed.
- NUL, bidirectional override controls, unpaired surrogates, and disallowed control characters fail.
- Empty values after normalization fail when required.
- Lists retain order and do not deduplicate silently.
- Canonical JSON uses the exact property order shown in 6.1, UTF-8, no insignificant whitespace, and a final newline.
- canonicalContentDigest is SHA-256 over canonical JSON bytes and is stored outside the canonical object.

### 8.2 Markdown escaping

All values are plain text. The renderer escapes backslash and Markdown punctuation that could create headings, links, images, HTML, code fences, or list structure beyond the template. Embedded HTML is never emitted. A list item is a single normalized line.

### 8.3 Canonical Markdown template

Sections with empty optional content are omitted. Required heading order never changes in payload version 1.

~~~markdown
# Skill recommendation: <skillName>

Recommendation ID: <recommendationId>

## Purpose

<purpose>

## Why this is recommended

<whyRecommended>

## When to use it

- <whenToUse item>

## Suggested procedure

1. <suggestedProcedure item>

## Evidence summary

- <evidenceSummary item>

## Proposed files

- <path> - <purpose>

## Resources

- <label> (<kind>): <reference>

## Overlap with existing skills

<overlapSummary>

## Exclusions

- <exclusion>

## Next review action

<nextReviewAction>
~~~

The final file has LF endings and one final newline. Saved location is recommendations/<recommendationId>.md but is not repeated inside the Markdown because the ID already anchors it.

### 8.4 Full route-neutral alert template

~~~text
Skill recommendation: <skillName>

Purpose: <purpose>

Why: <whyRecommended>

Use it when:
- <trigger>

Suggested procedure:
1. <step>

Next: <nextReviewAction>

Saved recommendation: <recommendationId>
Location: recommendations/<recommendationId>.md
~~~

Optional safe evidence, proposed files, resources, overlap, and exclusions may follow when budget permits. Route adapters add provider formatting only after escaping.

## 9. State machines

### 9.1 Content

~~~text
DRAFT -> VALIDATED -> FINALIZED -> MARKDOWN_RENDERED -> OWNER_VISIBLE
DRAFT or VALIDATED -> REJECTED
Any persisted digest conflict -> RECOVERY_REQUIRED
~~~

### 9.2 Delivery rendering

~~~text
FULL -> FITS
FULL -> SHORTENING -> FITS
SHORTENING -> CANNOT_PRESERVE_REQUIRED_MEANING -> REJECTED
~~~

A renderer never returns truncated invalid text and never silently drops required meaning.

## 10. Algorithms

### 10.1 Validation

1. Require an object from the typed assessment boundary.
2. Reject unknown fields before coercion.
3. Normalize each string.
4. Apply field and aggregate bounds.
5. Validate relative paths and public URIs.
6. Run secret, private identity, machine-path, and unsafe-pattern scans.
7. Require at least one whenToUse and one suggestedProcedure.
8. Return an immutable ValidatedDraft.

### 10.2 Safe evidence summary

1. Start from SDD 003 safe evidence only.
2. Produce derived observations, not raw transcript excerpts.
3. Remove names, credentials, IDs, private paths, unrelated content, and provider bodies.
4. Express only the fact needed to support the recommendation.
5. Re-run central redaction and field bounds.
6. Omit a summary if safety cannot be proved; do not insert the raw source.
7. Store an omitted-count reason only in private diagnostics, not in user content.

### 10.3 Destination shortening

1. Render the full route-neutral template and measure with the route adapter.
2. If it fits, return it.
3. Remove optional sections in this order: evidenceSummary, resources, proposedFiles, exclusions, overlapSummary.
4. Limit whenToUse to the first 3 and suggestedProcedure to the first 5; append one omission marker.
5. Shorten purpose to 240 and whyRecommended to 500 scalar values at word boundaries.
6. Shorten each retained trigger to 180 and procedure step to 240.
7. Preserve title, nonempty why, at least one trigger, at least one step, next action, recommendation ID, and relative location.
8. If still too large, produce the compact template in 10.4.
9. If the compact template cannot fit a route budget of at least 256 measured units, return content_limit_too_small and do not send.
10. Compute renderedDigest over exact UTF-8 plainText.

No shortening cuts a Unicode scalar, escape sequence, or provider entity.

### 10.4 Compact template

~~~text
Skill recommendation: <skillName>
Why: <short safe why>
Use when: <first trigger>
First step: <first procedure step>
Next: <short next action>
Saved: <recommendationId> at recommendations/<recommendationId>.md
~~~

## 11. Concurrency, transactions, idempotency, and versioning

- Final content is immutable after owner visibility.
- Finalization allocates recommendationId and createdAt, serializes canonical JSON, and renders the intended Markdown bytes before the assessment commit stores the durable draft identity and both digests. SDDs 003 and 004 own the transaction.
- UNIQUE completion and recommendation relations from SDD 004 prevent duplicate content.
- Canonical JSON and Markdown rendering are pure functions.
- payloadVersion is stored in each outbox row.
- A renderer implementation change that can change bytes requires a new payloadVersion.
- Re-rendering the same version must produce the same digest.
- Delivery loads content in a read transaction and verifies its digest before rendering.
- Route-specific escaping is pure and versioned by SDD 007 or SDD 009.
- No route can update the stored recommendation.

## 12. Error, retry, timeout, cancellation, and crash behavior

- Invalid or unsafe draft: assessment result is rejected before commit or remains pending for review according to SDD 003.
- Oversized content: reject with field-specific safe reasons; never truncate canonical storage silently.
- Markdown write failure: SDD 003/004 publication recovery applies.
- Digest mismatch: RECOVERY_REQUIRED; no route rendering.
- Unsupported payload version: PAUSED or DEAD_LETTER according to SDD 006 permanent classification.
- Destination budget change: render with the stored payload version and current approved budget; digest is receipted.
- Cancellation during pure rendering produces no mutation.
- Crash after rendering before send is harmless because outbox identity and immutable content remain.

## 13. Security, authorization, privacy, redaction, and permissions

Prohibited content includes:

- tokens, keys, passwords, cookies, authorization headers, and pairing codes;
- Telegram user/chat IDs and internal Codex session IDs;
- absolute machine or home paths;
- raw prompts, long tool output, environment dumps, stack traces, and provider bodies;
- unapproved URLs with credentials, queries, or fragments;
- executable HTML, Markdown images, or hidden bidirectional text;
- opaque digest-only explanations presented as user meaning.

The content validator applies SDD 002 redaction, but redaction is not a license to persist irrelevant private data. Minimization occurs first. If safety is uncertain, reject or omit.

## 14. Observability, status, health, and logs

Metrics include validation result by safe reason, rendered payload version, full versus shortened count, omitted sections, render duration, and content-limit failure. Logs include recommendation ID and digests, not content bodies by default.

Status can show proposed skill name and relative saved location. It does not show evidence summary unless the user explicitly opens the recommendation.

## 15. Installation, migration, compatibility, backup, and rollback

contentSchemaVersion and payloadVersion migrate independently. Readers must support every version present in the supported schema fixtures. A content migration creates a new immutable version through an explicit audited operation; it never rewrites an owner-visible file silently. Backups include canonical JSON and Markdown. Older renderers reject unsupported future versions.

## 16. Test specification

1. Every field minimum, maximum, empty, unknown, and aggregate bound.
2. Unicode NFC, whitespace, control, surrogate, and bidi cases.
3. Relative paths and safe public URI cases.
4. Seeded secrets, private IDs, and machine paths.
5. Golden canonical JSON bytes and digest.
6. Golden Markdown for minimal, full, and optional-section inputs.
7. Raw internal JSON and digest-only input rejection.
8. Full, shortened, compact, and too-small route budgets.
9. Required meaning preserved under shortening.
10. Unicode/provider entity safe truncation.
11. Deterministic repeat rendering and payload-version change.
12. Stored and delivered name, meaning, ID, and relative-location consistency.
13. not-a-skill no-alert behavior.
14. extend-existing behavior matches the approved policy.

## 17. Objective acceptance evidence

- approved JSON schema and golden fixtures;
- exact canonical JSON and Markdown hashes;
- renderer captures for full and compact messages;
- destination-budget table;
- seeded sensitive-content scan across stored and delivered bytes;
- negative raw-object cases;
- recommendation ID and digest trace to outbox and receipt;
- traceability for ACC-015 through ACC-018, ACC-021, and ACC-035.

## 18. Unresolved and deferred decisions

- Product owner must approve, change, or reject the version-1 mandatory schema and bounds.
- Proposed version-1 default: not-a-skill sends no alert, as required by ACC-014; extend-existing is stored but sends no alert. An approved extension-alert design would require its own safe schema and synchronized SDD 003/006 changes.
- SDD 007 owns Telegram measurement, formatting, and provider limit.
- SDD 009 owns selected-session turn formatting and its budget.
- Localization and attachments are later work.

## 19. Cross-spec dependencies and traceability

| Contract | Owner | Content use |
|---|---|---|
| Secret and path redaction | 002 | validation and output |
| Assessment draft | 003 | input |
| Durable content and file rows | 004 | storage |
| Outbox payload version and receipt | 006 | delivery |
| Telegram formatting | 007 | provider text |
| Session formatting | 009 | Codex turn |

### 19.1 Requirement-to-test trace

Test IDs 005-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| MSG-001 | Canonical Markdown and human alert renderers | 005-T06 through 005-T09, 005-T12, 005-T14 | ACC-016, ACC-017, ACC-021, ACC-035 |
| MSG-002 | Bounds, safety scan, escaping, and shortening | 005-T01 through 005-T04, 005-T07 through 005-T10 | ACC-017, ACC-018, ACC-035 |
| MSG-003 | Canonical identity, digest, and route consistency | 005-T05, 005-T06, 005-T11, 005-T12 | ACC-016, ACC-021 |

ACC-018 authority: 002 removes secrets, identities, and machine paths; 003 minimizes evidence; 005 is final authority over fields allowed into a recommendation or alert.

## 20. Implementation checklist

- [ ] Implement exact schema and bounds in section 6.
- [ ] Implement normalization and prohibited-content scan.
- [ ] Implement canonical JSON serializer.
- [ ] Implement deterministic Markdown template and escaping.
- [ ] Implement route-neutral full and compact templates.
- [ ] Implement budget-aware shortening.
- [ ] Implement content and payload version checks.
- [ ] Implement immutable stored-content lookup.
- [ ] Add all golden, negative, and security tests.
- [ ] Obtain schema and notification-policy approval before governed code.
