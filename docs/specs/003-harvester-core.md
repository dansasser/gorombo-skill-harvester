# SDD 003: Harvester core

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester harvesting pipeline
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: completion intake, evidence minimization, correlation, assessment, outcomes, recommendation publication handoff, direct enqueue, local completion acknowledgement, replay, and crash recovery
- Approval blockers: the canonical recommendation fields must be approved jointly with SDD 005, and the proposed assessment retry policy must be approved

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification implements HAR-001 through HAR-005.

It owns ACC-014, ACC-015, ACC-016, ACC-019, ACC-020, the Harvester portions of ACC-018 and ACC-022, and the source side of ACC-021.

Confirmed behavior:

1. Persist the completion event before assessment.
2. Record exactly one of not-a-skill, extend-existing, or propose-new.
3. For propose-new, persist matching database and owner-visible Markdown before route enqueue.
4. Enqueue directly after owner visibility; never poll completion records for finished recommendations.
5. Mark the completion acknowledged locally only after delivery rows are durably scheduled.
6. Replay and restart must not create an unintended second proposal.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Turn a bounded completion event into one durable skill-development decision and, when appropriate, one safe human-readable recommendation that is handed directly to the delivery outbox.

### 3.2 Goals

- Require a stable source event identity.
- Minimize and redact evidence before persistence.
- Freeze the assessment input and existing-skill catalog revision.
- Validate a typed assessment result.
- Prevent outcome changes after commit.
- Publish deterministic Markdown with database digest agreement.
- Enqueue enabled routes in the visibility transaction.
- Recover at every file and transaction boundary.
- Finalize the local completion record idempotently without reassessing.

### 3.3 Non-goals

- Generating the new skill itself.
- Automatically modifying an existing skill.
- Sending provider messages.
- Telegram task execution.
- Defining provider retry behavior.
- Polling any completion table for new work.
- Treating all completed tasks as skill candidates.

## 4. Terminology

- Completion source: the trusted Codex PostToolUse hook that observes a successful update_goal transition to complete.
- Source event ID: the verified correlation key derived from platform, task ID, generation, and source revision.
- Correlation key: domain-separated digest of source identity.
- Safe evidence: bounded, redacted evidence allowed to reach assessment and storage.
- Catalog snapshot: immutable view of known skills used for overlap analysis.
- Assessment version: identifier for prompt, rules, schema, and model policy.
- Outcome: one of not-a-skill, extend-existing, or propose-new.
- Qualified outcome: propose-new in version 1.
- Recommendation draft: safe typed content before Markdown rendering.
- Owner-visible: final Markdown is durable, verified, and represented by a visible database row.
- Completion acknowledgement: a local idempotent database transition recording that durable handling completed; version 1 makes no external acknowledgement call.
- Replay: receipt of the same correlation identity again.
- Durable boundary: committed database transaction or synced file visibility step.

## 5. Actors and journeys

- Codex goal-completion hook validates and submits TaskCompletionEvent after update_goal completes.
- Evidence sanitizer from SDD 002/005 minimizes sensitive content.
- Skill inventory adapter discovers configured roots and produces a canonical persisted snapshot.
- Assessor evaluates the frozen request and returns one typed outcome.
- Storage from SDD 004 owns transactions and file consistency.
- Renderer from SDD 005 creates canonical Markdown and route-neutral content.
- Outbox from SDD 006 inserts route rows and wakes workers.
- Completion finalizer records local acknowledgement only after scheduling.

Normal propose-new journey:

1. Validate the trusted goal-completion event and recompute its identity.
2. Sanitize evidence and verify its digest.
3. Insert the completion event before returning queued to the hook.
4. Canonicalize and persist the exact catalog snapshot used by assessment.
5. Claim, assess, and validate one typed result.
6. For propose-new, finalize identity and render canonical JSON and intended Markdown in memory.
7. Commit the outcome and a DRAFT_COMMITTED recommendation row before file I/O.
8. Sync and verify Markdown.
9. In one transaction, mark owner-visible, insert enabled route rows, and mark completion scheduled.
10. Commit, wake route workers, and locally acknowledge the completion.

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 TaskCompletionEvent version 1

The sole version-1 completion source is the trusted PostToolUse hook after update_goal successfully sets a goal to complete. App Server notifications are health input only and may not submit Harvester completions.

~~~json
{
  "schemaVersion": 1,
  "platform": "codex",
  "adapterVersion": "codex-goal-completion-v1",
  "taskId": "source-task-id",
  "terminalStatus": "complete",
  "generation": 0,
  "completedAt": 0,
  "sourceRevision": "release-revision",
  "correlationKey": "64-lowercase-hex",
  "completionEvidenceDigest": "64-lowercase-hex",
  "evidence": [
    {
      "kind": "user_request",
      "text": "bounded candidate evidence",
      "artifactPath": "optional/project-relative/path"
    }
  ]
}
~~~

Optional graphIdentity has exactly graphId, graphRunId, graphVersion, and graphChecksum.

Rules:

- platform is exactly codex and adapterVersion is exactly codex-goal-completion-v1.
- taskId is 1 through 256 UTF-8 bytes; generation is a nonnegative integer.
- terminalStatus is exactly complete; all other statuses are rejected.
- completedAt is nonnegative UTC Unix milliseconds.
- sourceRevision is required, 1 through 128 safe UTF-8 bytes, and must equal the loaded release binding.
- correlationKey and completionEvidenceDigest are full lowercase 64-hex values and are recomputed.
- evidence has 1 through 32 elements; text is at most 2000 scalar values per element and 16000 total.
- kind is user_request, agent_result, tool_summary, artifact_ref, or constraint.
- artifactPath is optional and project-relative under SDD 002.
- Unknown fields, kinds, or graphIdentity members fail.
- The hook returns queued only after durable intake commit. Duplicate returns the stored safe status. Rejected input does not trigger a worker.

### 6.2 Correlation and evidence identity

~~~text
canonicalIdentity = canonical JSON UTF-8 bytes of:
{"platform":value,"taskId":value,"generation":value,"sourceRevision":value}

correlationKey = lowercase hex SHA-256(canonicalIdentity)
sourceAdapter = "codex-goal-completion-v1"
sourceEventId = correlationKey
completionEvidenceDigest =
  lowercase hex SHA-256(canonical JSON UTF-8 bytes of normalized safe evidence)
~~~

Canonical JSON uses the exact property order shown, UTF-8, no insignificant whitespace, one final newline, and JSON string escaping. Intake rejects a supplied digest mismatch. The source hook's responsibility ends after durable enqueue and worker trigger; later completion acknowledgement is local storage state.

### 6.3 CatalogSnapshot version 1

~~~json
{
  "schemaVersion": 1,
  "roots": [
    {"rootId": "codex-root:skills", "origin": "codex", "precedence": 100, "required": true}
  ],
  "skills": [
    {
      "skillRef": "codex-root:skills/example/SKILL.md",
      "name": "example",
      "description": "Public description",
      "rootId": "codex-root:skills",
      "relativeSkillPath": "example/SKILL.md",
      "skillManifestSha256": "64-lowercase-hex",
      "valid": true,
      "errorCodes": [],
      "duplicate": false,
      "inventoryPreferred": true
    }
  ],
  "rootErrors": []
}
~~~

Configured roots come from SDD 002 anchor plus relativePath records. Runtime platform-adapter roots may be added with stable rootId, origin, precedence, and required; their absolute paths exist only in memory. Discovery traverses at most eight directory levels, does not follow links, and accepts only SKILL.md files with bounded YAML frontmatter. Persisted paths are root-relative.

Roots sort by precedence then rootId. Skills sort by precedence, rootId, and relativeSkillPath. Duplicate names use the same order; only the first valid record is inventoryPreferred. Invalid records and bounded safe root errors remain in the snapshot, but an error in a required root makes assessment retry rather than propose from an incomplete catalog. Only valid inventoryPreferred skills are extend-existing candidates.

Canonical snapshot JSON is at most 2,000,000 UTF-8 bytes. catalogRevision is the lowercase SHA-256 of its exact canonical bytes. The exact bytes and revision are committed in skill_catalog_snapshots before assessor invocation and retained with every referenced assessment.

### 6.4 AssessmentRequest version 1

~~~json
{
  "schemaVersion": 1,
  "correlationKey": "64-hex",
  "assessmentVersion": "harvester-assessment-v1",
  "safeEvidence": [],
  "safeEvidenceDigest": "64-hex",
  "catalogRevision": "64-hex",
  "catalogEntries": []
}
~~~

The catalog contains stable skill reference, public name, description, trigger summary, and project-relative package location. The request is stored or reconstructable from immutable digests before assessment begins.

### 6.5 Outcome union

not-a-skill:

~~~json
{
  "decision": "not-a-skill",
  "reasonCode": "one-off-task",
  "reasonSummary": "A bounded safe explanation."
}
~~~

extend-existing:

~~~json
{
  "decision": "extend-existing",
  "targetSkillRef": "stable-catalog-reference",
  "targetSkillName": "Visible name",
  "reasonSummary": "Why the existing skill is the right home.",
  "extensionSummary": "The behavior that should be added."
}
~~~

propose-new:

~~~json
{
  "decision": "propose-new",
  "reasonSummary": "Why a reusable skill is warranted.",
  "recommendation": {
    "contentSchemaVersion": 1,
    "skillName": "Proposed skill name",
    "purpose": "What it does",
    "whyRecommended": "Why it should exist",
    "whenToUse": ["Trigger"],
    "suggestedProcedure": ["Step"],
    "evidenceSummary": [],
    "proposedFiles": [],
    "resources": [],
    "overlapSummary": "",
    "exclusions": [],
    "nextReviewAction": "What the user should do next"
  }
}
~~~

SDD 005 is authoritative for exact recommendation bounds and rendering.

### 6.6 Postconditions by outcome

- not-a-skill: one immutable assessment; no recommendation and no delivery row.
- extend-existing: one immutable assessment with a valid catalog reference; no proposed-new recommendation. Alert policy is controlled by SDD 005.
- propose-new: one owner-visible recommendation, matching Markdown digest, one generation-zero outbox row per enabled route, and completion state scheduled.
- Every replay returns the existing correlation result without reassessment.

## 7. APIs, commands, events, and contracts

### 7.1 Core APIs

~~~text
acceptCompletion(event) -> IntakeResult
buildCatalogSnapshot(rootSet) -> CatalogSnapshot
claimAssessment(correlationKey, workerId) -> AssessmentClaim
recordAssessment(claim, outcome) -> AssessmentRecord
publishRecommendation(correlationKey) -> PublicationResult
acknowledgeCompletion(correlationKey) -> AcknowledgementResult
reconcileHarvester() -> ReconciliationReport
getOutcome(correlationKey) -> OutcomeView
~~~

### 7.2 Intake results

accepted_new, accepted_existing, rejected_invalid, rejected_unsafe, and retry_later. accepted_existing includes only safe status and stable record ID.

### 7.3 Stable events

completion.accepted, completion.replayed, catalog.snapshot_committed, assessment.claimed, assessment.committed, recommendation.file_durable, recommendation.owner_visible, delivery.enqueued, completion.ack_pending, completion.acknowledged, and harvester.recovery_required.

Events are emitted after their named durable boundary. recommendation.file_durable reports verified filesystem durability while the stored recommendation state remains DRAFT_COMMITTED; no event substitutes for a storage boundary.

## 8. Exact data and file contracts

SDD 004 owns columns and SQL. Harvester requires immutable logical records for:

- completion event, safe evidence digest, assessment due time, and fenced assessment claim;
- exact canonical catalog snapshot bytes and catalog revision;
- assessment input revision and outcome;
- stable recommendation ID, canonical content, intended Markdown path, and both digests before file I/O;
- recommendation visibility and owner-visible time;
- local completion acknowledgement state and attempt metadata;
- operational fault and reconciliation events.

Recommendation file name is the stable recommendation ID plus .md. The database stores recommendations/<id>.md, never an absolute path. Canonical content excludes the digest field; the SHA-256 digest is computed over exact UTF-8 Markdown bytes.

## 9. State machines

### 9.1 Completion

~~~text
Transient intake:
RECEIVED -> VALIDATED -> durable commit

Stored completion state:
ASSESSMENT_PENDING
  -> PUBLICATION_PENDING
  -> OWNER_VISIBLE_AND_SCHEDULED
  -> ACKNOWLEDGED
    (propose-new)

ASSESSMENT_PENDING
  -> ACK_PENDING
  -> ACKNOWLEDGED
    (not-a-skill or extend-existing)

Any stored state -> RECOVERY_REQUIRED on a defined invariant failure or exhausted retry policy
~~~

RECEIVED and VALIDATED are runtime-only intake phases and are never stored in `completion_events.state`. The durable commit creates ASSESSMENT_PENDING. propose-new follows the publication branch. not-a-skill and extend-existing follow the acknowledgement branch because version 1 does not enqueue extension notifications unless SDD 005 approves that policy. Completion acknowledgement is a local, idempotent transaction.

### 9.2 Assessment attempt

~~~text
PENDING -> CLAIMED -> COMMITTED
CLAIMED -> PENDING after an expired lease with no committed assessment
Any state -> RECOVERY_REQUIRED on identity or digest conflict
~~~

### 9.3 Recommendation visibility

~~~text
Stored DRAFT_COMMITTED
 -> runtime FILE_WRITING
 -> runtime FILE_DURABLE_VERIFIED
 -> stored OWNER_VISIBLE

Crash with no final file -> remain DRAFT_COMMITTED and retry publication
Crash with a final file whose digest matches -> FILE_DURABLE_VERIFIED, then visibility transaction
The visibility transaction moves the completion to OWNER_VISIBLE_AND_SCHEDULED and inserts initial outbox rows in INTEGRITY_PENDING.
Digest mismatch -> RECOVERY_REQUIRED
~~~

Outcome and canonical content are immutable after owner visibility.

## 10. Algorithms

### 10.1 Intake

1. Accept only a trusted goal-completion hook invocation after successful update_goal completion.
2. Validate TaskCompletionEvent bounds, release binding, terminal status, and optional graph identity.
3. Minimize and redact evidence before database persistence.
4. Canonicalize identity and safe evidence; recompute both supplied digests.
5. In a BEGIN IMMEDIATE transaction, insert the completion with assessment_next_at equal to received time or read the existing row.
6. If the same correlation identity has a different evidence digest, record correlation_conflict and return RECOVERY_REQUIRED.
7. Commit before returning queued or duplicate to the hook.
8. Wake the assessment worker directly. App Server notifications never enter this path.

### 10.2 Existing-skill lookup and assessment

1. In one BEGIN IMMEDIATE transaction, select one due ASSESSMENT_PENDING completion with no active lease, ordered by assessment_next_at, received_at, and ID.
2. Generate a 128-bit random assessment lease token, set owner and expiry to now plus 120000 ms, increment assessment_attempts, and commit.
3. Resolve the SDD 002 catalog roots, inventory without following links, normalize section 6.3, and compute exact canonical bytes and catalogRevision.
4. If a required root fails, clear the matching lease, set the approved retry due time, and do not invoke the assessor.
5. Insert or verify the immutable skill_catalog_snapshots row by revision. Same revision with different bytes is RECOVERY_REQUIRED.
6. Build the frozen AssessmentRequest from stored safe evidence and the persisted snapshot.
7. Invoke the assessor outside a transaction with a 90000 ms deadline.
8. Parse the exact outcome union; reject unknown or extra fields and verify extend-existing references against valid inventoryPreferred entries.
9. For propose-new, allocate a stable rec_ ID and createdAt, finalize SDD 005 canonical content, serialize canonical JSON, render intended Markdown in memory, and compute both digests and recommendations/<id>.md.
10. In one conditional transaction requiring the matching completion, ASSESSMENT_PENDING state, owner, and lease token:
   - insert exactly one assessment referencing catalogRevision;
   - for propose-new, store recommendation_id in the assessment and insert the DRAFT_COMMITTED recommendation row with canonical JSON, intended relative path, and intended Markdown digest;
   - clear assessment lease fields;
   - set completion to PUBLICATION_PENDING for propose-new or ACK_PENDING otherwise.
11. Commit. A stale token or existing assessment cannot overwrite the result.
12. For not-a-skill and extend-existing, invoke local completion acknowledgement.

A model response is not assumed bit-for-bit deterministic after an uncommitted crash. Replay determinism comes from immutable committed results, persisted catalog bytes, stable correlation, frozen inputs, and unique constraints.

### 10.3 Propose-new publication

1. Load the DRAFT_COMMITTED row and regenerate canonical JSON and Markdown bytes; both must equal stored intended digests.
2. Write Markdown to a private same-directory temporary file.
3. Sync file bytes.
4. Atomically rename to the deterministic final path.
5. Sync the parent directory where supported.
6. Reopen with no-follow, hash, and compare exact bytes.
7. In one SDD 004 transaction:
   - verify assessment, recommendation identity, DRAFT_COMMITTED state, and the matching digest evidence produced by step 6;
   - mark the recommendation OWNER_VISIBLE and set visible_at;
   - insert one generation-zero outbox row per currently enabled route in INTEGRITY_PENDING;
   - mark the completion OWNER_VISIBLE_AND_SCHEDULED.
8. Commit.
9. Reopen the final file with no-follow and verify its digest again.
10. If the digest matches, in one transaction change the exact generation-zero rows from INTEGRITY_PENDING to QUEUED. If it mismatches, in one transaction move the recommendation and completion to RECOVERY_REQUIRED and those rows to PAUSED with safe reason `recommendation_integrity`; do not wake or acknowledge.
11. Wake SDD 006 workers in the same runtime.
12. Invoke local completion acknowledgement, which changes only ACK_PENDING or OWNER_VISIBLE_AND_SCHEDULED to ACKNOWLEDGED through the defined completion transition.

### 10.4 Reconciliation

- Expired assessment lease with no committed assessment: clear the fenced lease and schedule the approved retry.
- Draft with no final file: regenerate from immutable canonical JSON and publish again.
- Final file with expected digest and draft pending: complete the visibility transaction, post-commit verification, and integrity-gate activation.
- Owner-visible recommendation with INTEGRITY_PENDING rows: repeat post-commit verification and atomically queue them or pause them with RECOVERY_REQUIRED.
- Final file with wrong digest: never overwrite; enter RECOVERY_REQUIRED and pause every nonterminal row for that recommendation.
- Visible recommendation with missing route rows: if the visibility transaction could not have committed atomically, treat as invariant violation.
- Completion acknowledgement pending: run the local conditional acknowledgement transaction only.
- No periodic scan discovers new completed work; reconciliation runs at startup, explicit doctor/recovery, and after a known interrupted internal operation.

## 11. Concurrency, transactions, locks, leases, and idempotency

- UNIQUE correlationKey prevents duplicate completion rows.
- UNIQUE completionId on assessments enforces one outcome.
- UNIQUE completionId and recommendation ID prevent duplicate recommendations.
- SDD 004 makes owner visibility and initial outbox fan-out one transaction.
- Assessment claims are token-fenced with durable owner, token, expiry, due time, and attempt count.
- External assessment happens outside write transactions.
- Completion acknowledgement is a local idempotent conditional update on the serialized write queue; it has no lease and no external ambiguity.
- Exact catalog snapshot bytes, catalog revision, and assessment version are stored with the result.
- A second intake for the same key never creates another assessment attempt after commit.
- Route changes after visibility do not rewrite the original fan-out; deliberate delivery operations are governed by SDD 006.

## 12. Error, retry, timeout, cancellation, and crash behavior

| Boundary | Crash or error result |
|---|---|
| Before completion commit | Source may redeliver; no row exists |
| After completion commit | Assessment resumes from stored event |
| During catalog lookup | Clear matching lease and schedule assessment retry |
| During assessment before commit | Lease expires and another attempt may run |
| After assessment commit | Never reassess |
| After temporary file sync | Temporary is removed only with proven ownership |
| After final rename before visibility | Reconcile digest and complete visibility |
| After visibility transaction before wake | Process crash causes startup drain; live process calls wake before returning |
| After wake before completion acknowledgement | Local acknowledgement remains pending; no duplicate enqueue or external call |
| During local acknowledgement | Conditional retry is idempotent |
| Digest or identity conflict | RECOVERY_REQUIRED |

Assistant-proposed version-1 assessment policy, requiring approval: 90000 ms assessor deadline, 120000 ms lease, and at most five claimed attempts. Retryable failures after attempts 1 through 4 wait 5 seconds, 30 seconds, 2 minutes, and 10 minutes. A retryable fifth failure or fifth expired lease enters RECOVERY_REQUIRED with assessment_exhausted and does not acknowledge the completion. Identity, snapshot, or digest conflicts enter RECOVERY_REQUIRED immediately. User cancellation stops new assessment work but does not roll back committed events or owner-visible recommendations.

## 13. Security, authorization, privacy, redaction, and permissions

- Raw prompts, tokens, credentials, home paths, full tool output, and unrelated files are not persisted as evidence.
- The evidence sanitizer uses allowlisted kinds and field bounds.
- Secret or machine-path findings are removed or replaced with safe summaries before assessment.
- The assessor receives only safe evidence and the public skill catalog snapshot.
- The assessor cannot request arbitrary file reads through its output.
- Recommendation content must pass SDD 005 safety validation.
- Markdown uses SDD 002 private permissions.
- Logs expose correlation and recommendation IDs, never evidence bodies by default.

## 14. Observability, status, health, and logs

Metrics:

- completions accepted, replayed, rejected, and conflicted;
- assessments pending, committed by decision, expired, and invalid;
- publication pending, owner-visible, and recovery-required;
- local completion acknowledgements pending and complete;
- duration histograms by bounded stage.

Status reports counts and oldest age, not content. Logs include stable IDs, assessment version, catalog revision digest, decision, and safe reason code.

## 15. Installation, migration, compatibility, backup, and rollback

SDD 004 migrates Harvester records. A new assessmentVersion does not rewrite old results. Reassessment requires a future explicit product operation with a new identity and audit contract; it is not implicit during update. Backups include completion, assessment, recommendation records, and Markdown. Rollback never downgrades owner-visible content in place.

## 16. Test specification

1. Valid intake and every invalid bound.
2. Missing stable event identity.
3. Same correlation replay with same digest.
4. Correlation identity with conflicting evidence digest.
5. All three outcomes and union validation.
6. Missing and stale catalog reference.
7. Assessor timeout, malformed output, stale lease, and competing workers.
8. Deterministic canonical identity and digest golden vectors.
9. File publication, digest agreement, and owner-visible transaction.
10. Direct enqueue wake with an assertion that no completion polling scheduler exists.
11. Local completion acknowledgement retry without reassessment or external call.
12. Fault injection after every transaction commit, file sync, rename, visibility commit, enqueue, wake, and acknowledgement boundary.
13. Seeded secret and machine-path evidence absent from stored and delivered content.
14. Trusted update_goal completion hook acceptance; non-complete and App Server notification rejection.
15. Catalog root normalization, canonical snapshot revision, duplicate precedence, required-root failure, and immutable replay.
16. Every proposed assessment delay, expiry, attempt-five exhaustion, and stale-token rejection.

## 17. Objective acceptance evidence

- exact database rows and invariant queries;
- canonical digest golden vectors;
- exact persisted catalog snapshot bytes, revision vectors, and frozen catalog fixtures;
- exact recommendation file bytes and matching digest;
- transaction trace for visibility and route fan-out;
- wake observation;
- replay database counts;
- fault matrix and restart results;
- seeded-private-evidence scan;
- traceability for ACC-014 through ACC-020 and shared ACC-018, ACC-021, and ACC-022.

## 18. Unresolved and deferred decisions

- Approval must confirm the SDD 005 recommendation schema.
- Product owner must approve, change, or reject the proposed five-attempt assessment policy and timing.
- Proposed version-1 default: not-a-skill and extend-existing do not emit alerts; extend-existing remains a durable queryable outcome. Changing this requires synchronized updates to SDDs 003, 005, and 006.
- SDD 011 must package and install the trusted PostToolUse update_goal hook without changing this event contract.
- Automated skill creation from a recommendation is later work.
- Retention is owned by SDD 004 and remains an approval gate.

## 19. Cross-spec dependencies and traceability

| Contract | Owner | Harvester use |
|---|---|---|
| Paths, redaction, secret safety | 002 | evidence and Markdown |
| Core schema and transactions | 004 | every durable boundary |
| Recommendation model and renderer | 005 | draft validation and file bytes |
| Outbox and wake | 006 | direct fan-out |
| Completion hook packaging | 011 | installs the 003 intake contract |
| Operations and lifecycle | 010 | startup reconciliation |

### 19.1 Requirement-to-test trace

Test IDs 003-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| HAR-001 | Goal-completion intake and durable event repository | 003-T01 through 003-T04, 003-T14 | ACC-014, ACC-018, ACC-019 |
| HAR-002 | Catalog snapshot, fenced assessment, and outcome union | 003-T05 through 003-T08, 003-T15, 003-T16 | ACC-014 through ACC-016, ACC-019 |
| HAR-003 | Recommendation finalization and publication | 003-T08, 003-T09, 003-T12, 003-T13 | ACC-016, ACC-018, ACC-021, ACC-022 |
| HAR-004 | Visibility transaction, fan-out, and direct wake | 003-T09, 003-T10, 003-T12 | ACC-020 through ACC-022 |
| HAR-005 | Replay, lease recovery, acknowledgement, and reconciliation | 003-T03, 003-T04, 003-T07, 003-T11, 003-T12, 003-T16 | ACC-019, ACC-022 |

ACC-022 consolidated ownership: 003 owns completion, assessment, file, visibility, and acknowledgement boundaries; 004 owns transaction and migration boundaries; 006 owns claim, external send, receipt, retry, and replay boundaries.

## 20. Implementation checklist

- [ ] Implement trusted TaskCompletionEvent validation and canonical identity.
- [ ] Implement evidence minimization and digesting.
- [ ] Implement durable intake and replay conflict handling.
- [ ] Implement catalog snapshots and assessment leases.
- [ ] Implement exact outcome union validation.
- [ ] Implement each outcome without substitution.
- [ ] Implement deterministic recommendation publication.
- [ ] Implement owner-visible plus outbox transaction.
- [ ] Implement direct wake and local completion acknowledgement.
- [ ] Implement startup and explicit reconciliation.
- [ ] Add all tests and evidence in sections 16 and 17.
- [ ] Obtain joint approval with SDDs 004 and 005 before product code.
