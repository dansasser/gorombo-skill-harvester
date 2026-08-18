# SDD 004: Storage schema and migrations

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester durable storage
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: SQLite configuration, schema version 1, IDs, timestamps, transactions, file/database consistency, migrations, backup, restore, compatibility, and retention hooks
- Approval blocker: the public retention default is not yet chosen; this draft proposes no automatic deletion

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification supplies the durable model required by PROD-003, ONB-002, ONB-004, HAR-001 through HAR-005, DEL-001 through DEL-004, TEL-001 and TEL-002, SES-001 and SES-003, and OPS-002 and OPS-003.

It owns ACC-048 through ACC-050 and the storage portions of ACC-001 through ACC-006, ACC-014 through ACC-016, ACC-019, ACC-022, ACC-033, ACC-038, and ACC-052.

Working technology choice: SQLite plus owner-visible Markdown. Approval of this SDD approves that choice for schema version 1.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Define a complete, implementable durable core that can survive replay, process restart, interrupted file publication, delivery failure, pairing, accepted tasks, and controlled updates without losing or silently duplicating user-visible work.

### 3.2 Goals

- One authoritative schema and migration history.
- Exact uniqueness and foreign-key rules.
- Full transaction boundaries for intake, assessment, publication, fan-out, claims, receipts, and replay.
- Private data files beneath the path authority.
- Deterministic IDs and time representation.
- Verifiable database/Markdown agreement.
- Safe backup and isolated restore.
- Honest incompatible-schema and interrupted-migration states.
- Storage shapes for later Telegram, task, and session specifications without deciding their protocols.

### 3.3 Non-goals

- Provider API behavior.
- Model assessment rules.
- Route message formatting.
- Service-manager installation.
- Automatic deletion before a retention policy is approved.
- Transparent downgrade to an older schema.

## 4. Terminology

- Schema version: monotonically increasing integer describing database structure and invariants.
- Migration checksum: SHA-256 of the packaged migration bytes.
- Public ID: prefixed random identifier safe to correlate in private diagnostics.
- Private identity: Telegram or session value stored privately and redacted from status.
- Write transaction: SQLite BEGIN IMMEDIATE transaction.
- Fenced write: update requiring the current opaque lease token.
- Visibility transaction: transaction that marks a recommendation visible and inserts initial outbox rows.
- Relative file reference: product-root-relative path validated by SDD 002.
- Reconciliation: comparison of durable database intent and file state after interruption.
- Backup set: database snapshot, non-secret config, recommendation files, and a digest manifest.
- Retention hook: queryable timestamps and relations that permit a later approved purge policy.

## 5. Actors and journeys

- Storage service owns database connections and repository APIs.
- Business components request typed operations; they do not execute ad hoc SQL.
- Runtime worker owns the only write queue.
- Read-only status uses bounded read transactions.
- Migration runner verifies package migrations and backup before changing schema.
- Backup operator creates and verifies a set.
- Restore operator validates into an isolated recovery directory before replacement.

A normal recommendation journey uses short transactions for completion intake, assessment claim, catalog snapshot persistence, assessment plus draft, owner visibility plus route fan-out, and local completion acknowledgement. External work never occurs while a write transaction is open.

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 Database location and connection

The database is the named path databaseFile from SDD 002. Every open verifies containment, regular-file type, private effective access, and expected application identity.

Required connection settings:

~~~sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
PRAGMA recursive_triggers = OFF;
~~~

WAL activation is verified from the returned value. The runtime records no READY status if a required pragma cannot be applied.

### 6.2 ID format

Public domain IDs use a fixed prefix followed by 32 lowercase hexadecimal characters generated from 128 cryptographically random bits:

- onb_ onboarding run
- evt_ completion event
- asm_ assessment
- rec_ recommendation
- out_ outbox row
- att_ delivery attempt
- rcp_ receipt
- rpl_ replay
- par_ pairing request
- bnd_ Telegram binding
- upd_ Telegram update
- ses_ session route
- tsk_ task
- run_ task run
- op_ operational event
- bak_ backup

An insert collision is retried with new random bytes at most three times; a fourth collision is a recovery-required fault. Correlation keys and content digests are full lowercase 64-hex SHA-256 values.

### 6.3 Time

All durable timestamps are INTEGER UTC Unix milliseconds. The wall clock is injected. Monotonic time controls in-process waits but is never persisted. A timestamp may not be negative. Ordering never relies on timestamp alone; ties use created_at then ID.

### 6.4 Preconditions

- Runtime ownership is proven.
- Schema identity and migration checks pass.
- The connection has required pragmas.
- Every JSON field has passed its owning schema.
- No secret value is supplied to a repository method.
- Every relative file reference passed SDD 002 validation.

### 6.5 Successful postconditions

Each repository operation either commits all documented rows or commits none. Foreign-key checking and invariant queries pass. A success result includes stable IDs and row versions, not secret or private bodies.

## 7. APIs, commands, events, and configuration

### 7.1 Storage service API

~~~text
openStorage(mode) -> StorageHandle
initializeStorage() -> SchemaState
migrateStorage(targetVersion) -> MigrationResult
transaction(operationName, callback) -> result
backupStorage() -> BackupResult
verifyBackup(backupId) -> VerificationResult
restoreBackup(backupId, targetRoot) -> RestorePlan
integrityCheck(level) -> IntegrityReport
reconcileFiles() -> ReconciliationReport
closeStorage() -> void
~~~

Typed repositories exist for onboarding, route configuration, completions, assessments, recommendations, outbox, pairings, Telegram updates, sessions, tasks, and operational events.

### 7.2 Operator commands

- gorombo-skill-harvester storage status --json
- gorombo-skill-harvester storage integrity --json
- gorombo-skill-harvester backup create
- gorombo-skill-harvester backup verify BACKUP_ID
- gorombo-skill-harvester restore plan BACKUP_ID
- gorombo-skill-harvester restore apply PLAN_ID after explicit confirmation

Commands expose only relative artifact names and safe counts.

### 7.3 Stable storage events

storage.opened, storage.integrity_failed, migration.started, migration.committed, migration.recovery_required, backup.created, backup.verified, restore.planned, restore.completed, and file.reconciled.

## 8. Exact schema, constraints, indexes, and file formats

### 8.1 Schema identity

- SQLite PRAGMA user_version is 1.
- schema_migrations contains version 1 with its packaged checksum.
- PRAGMA application_id is fixed at decimal 1196578354, hexadecimal 0x47525632 (ASCII GRV2), and is asserted by every open and migration test.
- READY requires all three to agree with the compiled schema descriptor.

### 8.2 Core DDL

The following is normative. Implementations may add WITHOUT ROWID only through an approved schema revision; they may not change names, nullability, checks, or uniqueness in version 1.

~~~sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  package_version TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK(applied_at>=0)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

CREATE TABLE onboarding_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN (
    'INSPECTING','PLANNED','WAITING_FOR_SECRET',
    'WAITING_FOR_ROUTE_CONFIGURATION','INITIALIZING_STORAGE',
    'VERIFYING_ROUTES','COMPLETED','CANCELLED','RECOVERY_REQUIRED'
  )),
  requested_route_mode TEXT CHECK(requested_route_mode IN ('telegram','session','both')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  safe_reason_code TEXT,
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=started_at)
);

CREATE TABLE route_configurations (
  route TEXT PRIMARY KEY CHECK(route IN ('telegram','session')),
  selected INTEGER NOT NULL CHECK(selected IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN (
    'DISABLED','UNCONFIGURED','CONFIGURED','VERIFYING',
    'READY','DEGRADED','RECOVERY_REQUIRED'
  )),
  safe_config_json TEXT NOT NULL CHECK(json_valid(safe_config_json)),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);

CREATE TABLE route_test_receipts (
  id TEXT PRIMARY KEY,
  route TEXT NOT NULL REFERENCES route_configurations(route),
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision>=1),
  test_generation INTEGER NOT NULL CHECK(test_generation>=0),
  provider_receipt_ref TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK(accepted_at>=0),
  safe_receipt_json TEXT NOT NULL CHECK(json_valid(safe_receipt_json)),
  UNIQUE(route, configuration_revision, test_generation)
);

CREATE TABLE completion_events (
  id TEXT PRIMARY KEY,
  correlation_key TEXT NOT NULL UNIQUE CHECK(length(correlation_key)=64),
  source_platform TEXT NOT NULL,
  source_adapter TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK(source_generation>=0),
  completed_at INTEGER NOT NULL CHECK(completed_at>=0),
  source_revision TEXT NOT NULL,
  safe_evidence_json TEXT NOT NULL CHECK(json_valid(safe_evidence_json)),
  safe_evidence_digest TEXT NOT NULL CHECK(length(safe_evidence_digest)=64),
  state TEXT NOT NULL CHECK(state IN (
    'ASSESSMENT_PENDING','PUBLICATION_PENDING',
    'OWNER_VISIBLE_AND_SCHEDULED','ACK_PENDING','ACKNOWLEDGED',
    'RECOVERY_REQUIRED'
  )),
  assessment_attempts INTEGER NOT NULL DEFAULT 0 CHECK(assessment_attempts>=0),
  assessment_next_at INTEGER,
  assessment_lease_token TEXT,
  assessment_lease_owner TEXT,
  assessment_lease_expires_at INTEGER,
  ack_attempts INTEGER NOT NULL DEFAULT 0 CHECK(ack_attempts>=0),
  ack_next_at INTEGER,
  received_at INTEGER NOT NULL CHECK(received_at>=0),
  scheduled_at INTEGER,
  acknowledged_at INTEGER,
  UNIQUE(source_adapter, source_event_id),
  CHECK(
    (assessment_lease_token IS NULL AND assessment_lease_owner IS NULL
      AND assessment_lease_expires_at IS NULL)
    OR
    (state='ASSESSMENT_PENDING' AND assessment_lease_token IS NOT NULL
      AND assessment_lease_owner IS NOT NULL
      AND assessment_lease_expires_at IS NOT NULL)
  ),
  CHECK(
    (state='ASSESSMENT_PENDING' AND assessment_next_at IS NOT NULL)
    OR
    (state<>'ASSESSMENT_PENDING' AND assessment_next_at IS NULL)
  )
);

CREATE TABLE skill_catalog_snapshots (
  revision TEXT PRIMARY KEY CHECK(length(revision)=64),
  catalog_schema_version INTEGER NOT NULL CHECK(catalog_schema_version=1),
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id),
  assessment_version TEXT NOT NULL,
  catalog_revision TEXT NOT NULL
    REFERENCES skill_catalog_snapshots(revision)
    CHECK(length(catalog_revision)=64),
  decision TEXT NOT NULL CHECK(decision IN (
    'not-a-skill','extend-existing','propose-new'
  )),
  reason_code TEXT,
  reason_summary TEXT NOT NULL,
  target_skill_ref TEXT,
  target_skill_name TEXT,
  extension_summary TEXT,
  recommendation_id TEXT UNIQUE,
  recommendation_json TEXT CHECK(
    recommendation_json IS NULL OR json_valid(recommendation_json)
  ),
  recommendation_digest TEXT CHECK(
    recommendation_digest IS NULL OR length(recommendation_digest)=64
  ),
  committed_at INTEGER NOT NULL CHECK(committed_at>=0),
  CHECK(
    (decision='not-a-skill' AND target_skill_ref IS NULL
      AND extension_summary IS NULL AND recommendation_id IS NULL
      AND recommendation_json IS NULL AND recommendation_digest IS NULL)
    OR
    (decision='extend-existing' AND target_skill_ref IS NOT NULL
      AND extension_summary IS NOT NULL AND recommendation_id IS NULL
      AND recommendation_json IS NULL AND recommendation_digest IS NULL)
    OR
    (decision='propose-new' AND target_skill_ref IS NULL
      AND extension_summary IS NULL AND recommendation_id IS NOT NULL
      AND recommendation_json IS NOT NULL
      AND recommendation_digest IS NOT NULL)
  )
);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id),
  assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(id),
  content_schema_version INTEGER NOT NULL CHECK(content_schema_version>=1),
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  canonical_json_digest TEXT NOT NULL CHECK(length(canonical_json_digest)=64),
  markdown_relative_path TEXT NOT NULL UNIQUE,
  markdown_sha256 TEXT NOT NULL CHECK(length(markdown_sha256)=64),
  visibility_state TEXT NOT NULL CHECK(visibility_state IN (
    'DRAFT_COMMITTED','OWNER_VISIBLE','RECOVERY_REQUIRED'
  )),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  visible_at INTEGER,
  CHECK(visibility_state<>'OWNER_VISIBLE' OR visible_at IS NOT NULL)
);

CREATE TABLE delivery_outbox (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
  route TEXT NOT NULL CHECK(route IN ('telegram','session')),
  payload_version INTEGER NOT NULL CHECK(payload_version>=1),
  delivery_generation INTEGER NOT NULL DEFAULT 0 CHECK(delivery_generation>=0),
  state TEXT NOT NULL CHECK(state IN (
    'INTEGRITY_PENDING','QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER','PAUSED'
  )),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_category TEXT,
  last_safe_error_json TEXT CHECK(
    last_safe_error_json IS NULL OR json_valid(last_safe_error_json)
  ),
  ambiguous_acceptance INTEGER NOT NULL DEFAULT 0
    CHECK(ambiguous_acceptance IN (0,1)),
  replay_of_delivery_id TEXT REFERENCES delivery_outbox(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  terminal_at INTEGER,
  UNIQUE(recommendation_id, route, payload_version, delivery_generation),
  CHECK(
    (state='SENDING' AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state<>'SENDING' AND lease_token IS NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>=1),
  lease_token TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  completed_at INTEGER,
  result_category TEXT CHECK(result_category IN (
    'accepted','retryable','rate_limited','route_blocked',
    'permanent','ambiguous','lease_expired','cancelled'
  )),
  safe_error_json TEXT CHECK(safe_error_json IS NULL OR json_valid(safe_error_json)),
  UNIQUE(delivery_id, attempt_number)
);

CREATE TABLE delivery_receipts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES delivery_attempts(id),
  provider_receipt_ref TEXT NOT NULL,
  accepted_at INTEGER NOT NULL CHECK(accepted_at>=0),
  safe_receipt_json TEXT NOT NULL CHECK(json_valid(safe_receipt_json))
);

CREATE TABLE delivery_replays (
  replay_request_id TEXT PRIMARY KEY,
  original_delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
  replay_delivery_id TEXT NOT NULL UNIQUE REFERENCES delivery_outbox(id),
  requested_by TEXT NOT NULL,
  safe_reason TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK(requested_at>=0)
);
~~~

### 8.3 Later-route and task durable tables

The storage shape is fixed here; SDDs 007 through 009 own authorization and transition semantics.

~~~sql
CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE CHECK(length(code_digest)=64),
  bot_identity TEXT NOT NULL,
  user_identity TEXT NOT NULL,
  chat_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','EXPIRED','REJECTED','USED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE telegram_bindings (
  id TEXT PRIMARY KEY,
  bot_identity TEXT NOT NULL,
  user_identity TEXT NOT NULL,
  chat_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED','RECOVERY_REQUIRED')),
  approved_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(bot_identity, user_identity, chat_identity)
);

CREATE TABLE session_routes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  internal_thread_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN (
    'SELECTED','READY','BUSY','MISSING','INACCESSIBLE','RESELECTION_REQUIRED'
  )),
  revision INTEGER NOT NULL CHECK(revision>=1),
  selected_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source_route TEXT NOT NULL CHECK(source_route IN ('telegram')),
  source_message_identity TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES telegram_bindings(id),
  request_text_private TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'ACCEPTED','QUEUED','RUNNING','WAITING_APPROVAL',
    'SUCCEEDED','FAILED','CANCELLED','RECOVERY_REQUIRED'
  )),
  accepted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_number INTEGER NOT NULL CHECK(run_number>=1),
  state TEXT NOT NULL,
  thread_id_private TEXT,
  safe_result_json TEXT CHECK(safe_result_json IS NULL OR json_valid(safe_result_json)),
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(task_id, run_number)
);

CREATE TABLE task_result_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN (
    'QUEUED','SENDING','RETRY_WAIT','SENT','DEAD_LETTER'
  )),
  message_private TEXT NOT NULL,
  message_digest TEXT NOT NULL CHECK(length(message_digest)=64),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  provider_receipt_ref TEXT,
  last_error_category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  CHECK(
    (state='SENDING' AND lease_token IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state<>'SENDING' AND lease_token IS NULL
      AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE telegram_updates (
  update_identity TEXT PRIMARY KEY,
  binding_id TEXT REFERENCES telegram_bindings(id),
  task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK(state IN ('REJECTED','ACCEPTED','DUPLICATE')),
  received_at INTEGER NOT NULL
);

CREATE TABLE operational_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  correlation_id TEXT,
  safe_detail_json TEXT NOT NULL CHECK(json_valid(safe_detail_json)),
  created_at INTEGER NOT NULL
);
~~~

Pairing codes are never stored in plaintext. Private identity columns are never returned by general status. Task text is private runtime state, not a secret, and is accessible only to SDD 008 repositories.

### 8.4 Required indexes

~~~sql
CREATE INDEX completion_assessment_due
  ON completion_events(state, assessment_next_at, received_at, id);
CREATE INDEX completion_assessment_lease
  ON completion_events(state, assessment_lease_expires_at, id);
CREATE INDEX completion_ack_due
  ON completion_events(state, ack_next_at, received_at, id);
CREATE INDEX catalog_snapshot_created
  ON skill_catalog_snapshots(created_at, revision);
CREATE INDEX recommendation_visibility
  ON recommendations(visibility_state, created_at, id);
CREATE INDEX outbox_claim_due
  ON delivery_outbox(state, next_attempt_at, created_at, id);
CREATE INDEX outbox_lease_due
  ON delivery_outbox(state, lease_expires_at, id);
CREATE INDEX outbox_route_state
  ON delivery_outbox(route, state, updated_at, id);
CREATE INDEX attempt_delivery_started
  ON delivery_attempts(delivery_id, started_at, id);
CREATE INDEX pairing_expiry
  ON pairing_requests(state, expires_at, id);
CREATE INDEX tasks_state_updated
  ON tasks(state, updated_at, id);
CREATE INDEX task_result_due
  ON task_result_deliveries(state, next_attempt_at, id);
CREATE INDEX operations_component_time
  ON operational_events(component, created_at, sequence);
~~~

### 8.5 Recommendation file

- Path: recommendations/<recommendation-id>.md.
- UTF-8, LF line endings, final newline.
- Maximum 256 KiB in schema version 1.
- Private effective access.
- Digest: lowercase SHA-256 over exact bytes.
- No absolute path stored.

### 8.6 Repository-enforced invariants

SQLite constraints are necessary but not sufficient for cross-row or digest equality. Repository methods MUST enforce these invariants at their named boundaries. All row-only checks occur in the same `BEGIN IMMEDIATE` transaction that creates or changes the related records. File equality is verified immediately before the visibility transaction and again after commit.

- `skill_catalog_snapshots.revision` equals lowercase SHA-256 over the exact UTF-8 bytes stored in `canonical_json`.
- For TaskCompletionEvent version 1, `completion_events.source_event_id` equals `correlation_key`, and recomputing the canonical identity from `source_platform`, `task_id`, `source_generation`, and `source_revision` yields the same key.
- A `propose-new` assessment has exactly one related recommendation, and its `recommendation_id`, `recommendation_json`, and `recommendation_digest` equal the related recommendation row fields `id`, `canonical_json`, and `canonical_json_digest`. Other assessment decisions have no recommendation values and no recommendation row for that completion.
- A route test allocates `test_generation` as `COALESCE(MAX(test_generation), -1) + 1` for one route and configuration revision inside the route-test transaction.
- A recommendation marked OWNER_VISIBLE has a final file at `markdown_relative_path` whose exact bytes hash to `markdown_sha256`.
- Generation-zero fan-out rows enter INTEGRITY_PENDING. No row may enter QUEUED or RETRY_WAIT until the post-commit digest check succeeds. An integrity fault atomically moves the recommendation and completion to RECOVERY_REQUIRED and every nonterminal outbox row for that recommendation to PAUSED before any delivery wakeup.

The same invariant set MUST run after database open, after every migration, and during backup verification and restore verification. A mismatch records a safe operational event and moves the owning record or schema lifecycle to RECOVERY_REQUIRED; it is never auto-repaired.

## 9. State machines

### 9.1 Schema

~~~text
ABSENT -> INITIALIZING -> CURRENT
OLDER_SUPPORTED -> BACKING_UP -> MIGRATING -> VERIFYING -> CURRENT
Any uncertain migration -> RECOVERY_REQUIRED
NEWER_UNSUPPORTED -> RECOVERY_REQUIRED
~~~

### 9.2 Backup

~~~text
CREATING -> VERIFYING -> VERIFIED
CREATING or VERIFYING -> INVALID
VERIFIED -> RESTORE_PLANNED -> RESTORED
~~~

### 9.3 Recommendation consistency

DRAFT_COMMITTED means the stable recommendation ID, canonical JSON, canonical digest, intended relative Markdown path, and intended Markdown digest are committed before file I/O. File-durable verification is a runtime condition while the row remains DRAFT_COMMITTED; it is not a stored visibility state. OWNER_VISIBLE and RECOVERY_REQUIRED follow SDD 003. OWNER_VISIBLE may be committed only after the pre-transaction digest check; delivery wakeup is legal only after the post-commit digest check succeeds and visible_at is set.

### 9.4 Outbox

INTEGRITY_PENDING, QUEUED, SENDING, RETRY_WAIT, SENT, DEAD_LETTER, and PAUSED. INTEGRITY_PENDING is non-claimable. Exact transitions are owned by SDD 006 and enforced by repositories.

## 10. Algorithms and transaction boundaries

### 10.1 Transaction table

| Operation | Transaction contents | External work |
|---|---|---|
| Intake | Insert completion with assessment due time or read same correlation | None |
| Assessment claim | Fence one due completion, increment assessment attempts, set owner/token/expiry | Catalog inventory and assessor after |
| Catalog snapshot | Insert exact canonical bytes by revision or verify identical existing row | Inventory before |
| Assessment commit | Insert assessment; for propose-new also insert DRAFT_COMMITTED recommendation identity, canonical JSON, intended path, and digests; clear claim | Assessor and deterministic render before |
| Completion acknowledgement | Conditionally mark ACKNOWLEDGED and clear due time | None |
| Visibility plus fan-out | Verify expected draft/file state, mark visible, insert enabled route rows as INTEGRITY_PENDING, mark completion scheduled | File sync before; post-commit verify after |
| Integrity gate | Change exact INTEGRITY_PENDING rows to QUEUED, or pause them and mark owning records RECOVERY_REQUIRED | Post-commit file verification before |
| Route configuration | Update one route revision and selection | Test after |
| Delivery claim | Select one due row, set SENDING lease, increment count, insert attempt | Send after |
| Accepted delivery | Insert receipt, complete attempt, set SENT, clear lease | Provider call before |
| Failed delivery | Complete attempt, set RETRY_WAIT, PAUSED, or DEAD_LETTER, clear lease | Provider call before |
| Replay | Insert next generation row and replay audit | Wake after |
| Pair approval | Fence pending request, create or activate binding, consume code | Local approval before final commit |
| Task acceptance | Deduplicate update, insert task, mark accepted update | Authorization before |
| Migration | Apply one packaged migration and migration row | Backup before |
| Settings | Compare expected version, update JSON and version | None |

All write transactions use BEGIN IMMEDIATE and are kept short.

### 10.2 File publication

1. Finalize canonical content and render intended Markdown bytes in memory.
2. In the assessment commit, insert the assessment and DRAFT_COMMITTED recommendation row with stable ID, canonical JSON, intended relative path, and both digests.
3. Reload the draft and reconstruct both byte sequences; verify stored digests.
4. Create a private temporary file in recommendations.
5. Write, sync, and close.
6. Rename atomically to the final deterministic name.
7. Sync the directory where supported.
8. Reopen no-follow and verify the digest.
9. Execute visibility plus fan-out transaction, inserting route rows in INTEGRITY_PENDING.
10. Reopen no-follow and verify the final digest after commit.
11. In one transaction, change the exact INTEGRITY_PENDING rows to QUEUED on success; on mismatch, change them to PAUSED and mark the recommendation and completion RECOVERY_REQUIRED.
12. Only after successful queue activation, wake workers and run local completion acknowledgement.

A crash after draft commit has stable bytes and a stable final name. A crash after rename leaves a deterministic orphan candidate. A crash after visibility commit leaves only non-claimable INTEGRITY_PENDING rows. Startup reconciliation derives expected bytes from the immutable draft and completes the integrity gate. Matching bytes are promoted; mismatching bytes are paused for explicit recovery and never overwritten silently.

### 10.3 Assessment claim and acknowledgement

SDD 003 supplies exact assessment eligibility, timing, and retry. Storage conditionally selects a due ASSESSMENT_PENDING completion, stores a random lease token, owner, and expiry, increments assessment_attempts, and fences assessment commit by completion ID plus token. Expiry recovery clears only a matching unresolved claim and sets the next due time or RECOVERY_REQUIRED.

Completion acknowledgement is local. A conditional write accepts ACK_PENDING or OWNER_VISIBLE_AND_SCHEDULED, increments ack_attempts, sets ACKNOWLEDGED and acknowledged_at, and clears ack_next_at. Repeating it returns the existing acknowledged row; it has no external call or lease.

### 10.4 Delivery claim

SDD 006 supplies exact eligibility. Storage performs selection and update in one write transaction, requires a claimable row state and due time, an owner-visible recommendation, and a completion outside RECOVERY_REQUIRED; it creates a random lease token, sets expiry, increments attempt_count, and inserts the matching attempt. Only matching delivery ID plus lease token may complete it.

## 11. Concurrency, locks, leases, and idempotency

- One process owns the runtime lock and one serialized SQLite write queue.
- Read connections may run concurrently in WAL mode.
- Writers use BEGIN IMMEDIATE and a 5000 ms busy timeout; business code does not loop forever.
- Unique constraints are the final idempotency authority.
- Leases use wall-clock expiry stored in milliseconds and opaque random tokens.
- A stale assessment token cannot commit an assessment or draft; a stale delivery token cannot write a result, receipt, retry, or error.
- Database calls never hold a transaction across network, model, App Server, or file-sync work.
- The runtime lock is ownership-recorded. A second instance may not delete or replace it without SDD 010 stale-owner proof.
- Checkpointing is explicit during clean shutdown, backup, and bounded maintenance; it is not used as a completion poll.

## 12. Error, retry, timeout, cancellation, and crash behavior

- SQLITE_BUSY after bounded wait returns storage_busy; caller applies its own bounded retry.
- SQLITE_CORRUPT, failed quick_check, foreign-key violation, application ID mismatch, or schema checksum mismatch returns RECOVERY_REQUIRED.
- Disk full during temporary write leaves prior database and visible file state unchanged.
- Commit uncertainty requires an immediate read by stable ID before retry.
- A catalog revision collision with different canonical bytes is RECOVERY_REQUIRED.
- An expired assessment lease follows the approved SDD 003 attempt policy and never commits a stale result.
- A cancelled transaction rolls back. Cancellation after commit returns the committed result.
- An expired SENDING lease is resolved by SDD 006 and never interpreted as success.
- Closing storage rejects new writes, waits for the current transaction, checkpoints when safe, and closes every connection.
- Temporary, WAL, SHM, lock, and endpoint cleanup occurs only with proven ownership.

## 13. Security, authorization, privacy, redaction, and permissions

- Database, WAL, SHM, backup sets, recommendation files, and manifests use private effective access.
- SQLite contains no bot token, API key, pairing plaintext code, authorization header, or secret fingerprint.
- Private Telegram and session identities are accessible only through typed repositories.
- General status returns counts and redacted names, not private identity columns.
- SQL parameters are bound; no business value is concatenated into SQL.
- JSON is validated before insert and bounded by its owning SDD.
- Database extensions, writable schema, and untrusted loadable modules are disabled.
- Backups exclude .env and redact operational details.
- Integrity diagnostics never dump row bodies.

## 14. Observability, status, health, and logs

Storage status reports schema version, migration state, quick-check state, WAL state, pending and dead-letter counts, oldest due age, backup verification state, and last successful write time. It reports no absolute path by default.

Operational events record component, event type, stable correlation ID, safe JSON, and time. The operational table is not a substitute for external logs and cannot contain secrets.

## 15. Installation, migrations, compatibility, backup, and rollback

### 15.1 Migration packaging

Each migration has version, previous version, SQL or typed migration entry, SHA-256 checksum, and invariant queries. Migrations are immutable after release. Apply every adjacent migration in order; do not skip.

### 15.2 Migration algorithm

1. Acquire runtime ownership and stop new business writes.
2. Inspect schema identity and run quick_check.
3. Create and verify a backup set.
4. Verify every packaged migration checksum.
5. Record a private migration intent artifact.
6. Apply one migration in a write transaction.
7. Insert schema_migrations row and update user_version in that transaction.
8. Commit.
9. Run exact schema comparison, foreign_key_check, quick_check, and invariant queries.
10. Remove the intent only after verification.
11. Resume work.

An interrupted uncommitted migration rolls back. A committed migration with a remaining intent is verified and finalized. Any checksum or schema mismatch is RECOVERY_REQUIRED.

### 15.3 Backup set

backups/<backup-id>/ contains:

- state.sqlite3 created by the SQLite backup API;
- config.json;
- recommendations/ copied with exact relative names;
- manifest.json containing version, created time, file sizes, and SHA-256 values.

It excludes .env, runtime endpoints, locks, WAL/SHM, transient logs, and plaintext secrets. Verification opens the copied database read-only, checks schema and integrity, and hashes every file.

### 15.4 Restore

Restore first materializes and verifies into recovery/<plan-id>/. It compares the current state and shows the replacement plan. Apply requires explicit confirmation, stops the service, makes a safety backup, atomically replaces owned artifacts where possible, preserves .env, reopens storage, runs all invariants, and only then returns READY.

### 15.5 Downgrade

Automatic downgrade is forbidden. An older package encountering a newer schema returns RECOVERY_REQUIRED without mutation. Recovery is to reinstall a compatible package or explicitly restore a verified older backup with acknowledged loss of newer state.

### 15.6 Retention

Proposed version-1 default: no automatic deletion of recommendations, outcomes, delivery history, tasks, bindings, or operational events. Explicit user-directed deletion and uninstall-data behavior belong to SDD 010. All terminal records carry timestamps and indexed relations so a later approved migration can implement retention. This public default requires product-owner approval.

## 16. Test specification

1. Fresh schema exact DDL, indexes, pragmas, application ID, and migration row.
2. Every constraint, foreign key, check, and unique collision.
3. ID generation and forced collision retries.
4. UTC millisecond and tie ordering.
5. Intake, assessment claim, catalog snapshot, assessment commit, local acknowledgement, visibility, delivery claim, success, failure, replay, pairing, and task transactions.
6. Stale assessment and delivery lease fencing.
7. WAL concurrent readers and serialized writers.
8. Busy timeout and cancellation.
9. Crash before and after every transaction commit.
10. File write, sync, rename, directory sync, visibility, and reconciliation faults.
11. Quick-check, foreign-key, checksum, application ID, and newer-schema failures.
12. Migration fixtures from every supported prior version.
13. Interrupted migration before and after commit.
14. Backup hash, isolated restore, failed restore rollback, and .env exclusion.
15. Private effective permissions for DB companions and backup files.
16. Retention default performs no automatic deletion.
17. Catalog snapshot canonicalization, revision collision, foreign key, and retention.
18. Assessment due ordering, claim expiry, attempt exhaustion, recommendation identity equality, and local acknowledgement idempotency.

## 17. Objective acceptance evidence

- canonical schema dump and expected digest;
- pragma and application identity report;
- migration fixture hashes and journal;
- transaction-level invariant queries;
- exact file/database digest agreement;
- two-process and stale-lease results;
- fault-injection matrix;
- verified backup manifest and isolated restore inventory;
- secret scan over DB, backup, recommendations, and diagnostics;
- traceability for ACC-048 through ACC-050 and all shared storage cases.

## 18. Unresolved and deferred decisions

- Product owner must approve, change, or reject the proposed no-automatic-deletion retention default.
- The frozen application_id is 1196578354 (0x47525632) and cannot change after schema version 1 migration bytes are approved.
- SDDs 007, 008, and 009 may add constraints or indexes through a reviewed schema revision but may not silently redefine version-1 columns.
- SDD 010 owns exact lock file, backup scheduling, service stop/start, and uninstall-data commands.
- Encryption at rest beyond host private access is not selected for version 1.

## 19. Cross-spec dependencies and traceability

| Contract | Owner | Storage responsibility |
|---|---|---|
| Paths and permissions | 002 | named files and private access |
| Harvester transitions | 003 | transaction inputs and outcomes |
| Content schema | 005 | canonical JSON and Markdown bounds |
| Delivery transitions | 006 | outbox repository |
| Telegram pairing | 007 | pairing semantics |
| Telegram tasks | 008 | task semantics |
| Selected session | 009 | session semantics |
| Lifecycle | 010 | lock, shutdown, backup operations |

### 19.1 Requirement-to-test trace

Test IDs 004-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| ONB-002, ONB-004 | Onboarding, route revision, and receipt repositories | 004-T01, 004-T02, 004-T05, 004-T09 | ACC-001 through ACC-006 |
| HAR-001 through HAR-005 | Completion, catalog, assessment, recommendation, and acknowledgement repositories | 004-T02, 004-T05, 004-T06, 004-T09, 004-T10, 004-T17, 004-T18 | ACC-014 through ACC-016, ACC-019, ACC-022 |
| DEL-001 through DEL-004 | Outbox, attempt, receipt, and replay repositories | 004-T02, 004-T05, 004-T06, 004-T09 | ACC-019, ACC-022 |
| TEL-001, TEL-002, PROD-003 | Pairing, binding, update, and task durable shapes | 004-T02, 004-T05, 004-T09, 004-T15 | ACC-033, ACC-038 |
| SES-001, SES-003 | Private session binding durable shape | 004-T02, 004-T05, 004-T09, 004-T15 | ACC-002, ACC-040 |
| OPS-002, OPS-003 | Integrity, backup, restore, and operational events | 004-T07 through 004-T15 | ACC-047 through ACC-050, ACC-052 |

SDD 004 is authoritative for the consolidated ACC-022 transaction and file fault matrix. SDD 003 defines expected Harvester recovery; SDD 006 defines delivery recovery.

## 20. Implementation checklist

- [ ] Implement and assert the frozen application_id 1196578354.
- [ ] Implement required SQLite pragmas and verification.
- [ ] Implement schema version 1 exactly.
- [ ] Implement typed repositories; prohibit ad hoc business SQL.
- [ ] Implement all transaction boundaries in section 10.
- [ ] Implement random prefixed IDs and UTC milliseconds.
- [ ] Implement recommendation file publication and reconciliation.
- [ ] Implement migration checksum, intent, and invariant flow.
- [ ] Implement verified backup and isolated restore.
- [ ] Implement private access and secret-safe diagnostics.
- [ ] Add every test and evidence item in sections 16 and 17.
- [ ] Obtain retention and joint SDD approval before governed product code.
