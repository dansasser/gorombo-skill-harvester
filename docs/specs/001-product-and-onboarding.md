# SDD 001: Product boundary and onboarding

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester product
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: product boundary, public readiness, first use, repeat onboarding, route changes, and recovery handoff
- Approval blockers: the exact selected-session discovery and selection protocol remains owned by SDD 009; this document fixes only the onboarding handoff and result contract

Revision history:

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification implements PROD-001, PROD-002, PROD-003, ONB-001, ONB-002, ONB-003, and ONB-004.

It owns acceptance cases ACC-001 through ACC-007, ACC-040 at the orchestration boundary, ACC-047 at the public status boundary, and ACC-051 at the clean-install readiness boundary.

Confirmed product decisions:

1. Gorombo Skill Harvester is one public skill product, not a loose merge of two repositories.
2. First-release delivery choices are Telegram, a selected Codex session, or both.
3. Telegram supports task intake as well as recommendation alerts.
4. A selected Codex session is chosen by its visible name and stored by its internal ID.
5. The product does not automatically pin a selected session.
6. Onboarding is resumable and must preserve valid existing state.
7. Product code remains out of scope until the governing SDDs are approved.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Define how the skill and its runtime determine whether setup is needed, guide the user through setup, verify every selected route, and return an honest readiness result before harvesting, delivery, or task work begins.

### 3.2 Goals

- Present one understandable product and one onboarding flow.
- Create only private state owned by Gorombo Skill Harvester.
- Support telegram, session, and both route modes.
- Resume partial setup without erasing completed work.
- Make route readiness independently visible.
- Give every blocked or degraded state a non-secret reason and next action.
- Make repeated onboarding idempotent unless the user explicitly requests a change.

### 3.3 Non-goals

- Telegram pairing protocol details; SDD 007 owns them.
- Telegram task execution and approval rules; SDD 008 owns them.
- Codex session discovery, naming, active-turn behavior, and turn submission; SDD 009 owns them.
- Service installation and host startup; SDD 010 owns them.
- Final plugin packaging and executable installation name; SDD 011 owns them.
- Discord, WhatsApp, or another delivery service in the first implementation.

## 4. Terminology

- Core ready: paths, configuration, schema, database, recommendation storage, and runtime ownership are usable.
- Selected route: a route included in routeMode.
- Configured route: its non-secret configuration and required binding or selection exist.
- Verified route: a bounded test delivery completed and has a durable receipt for the current route configuration.
- Initial setup: no earlier READY record exists for the current product state.
- Reconfiguration: an explicit user-requested change to route mode, pairing, token reference, or selected session.
- Readiness status: exactly one of READY, NEEDS_ONBOARDING, DEGRADED, or RECOVERY_REQUIRED.
- Reason code: a stable, non-secret machine-readable explanation.
- Next action: a bounded operation the user or agent can perform.
- Onboarding run: one durable attempt to inspect, plan, apply, and verify setup.
- Route adapter: the SDD 007 or SDD 009 implementation that configures and tests one destination.

## 5. Actors and journeys

### 5.1 Actors

- User: chooses routes, provides secrets outside the public package, approves pairing locally, and chooses a session.
- Codex agent: invokes readiness before work, explains required actions, and drives interactive onboarding.
- Gorombo Skill Harvester runtime: validates state, performs owned mutations, and records objective results.
- Telegram adapter: performs pairing handoff and a test message.
- Selected-session adapter: lists sessions, records a selection, and submits a test turn.
- Operator: invokes read-only status, recovery, backup, or route-change operations.

### 5.2 Fresh Telegram journey

1. The agent runs readiness.
2. Status is NEEDS_ONBOARDING with route_selection_missing or telegram_secret_missing.
3. The user chooses telegram.
4. The runtime creates owned private state and validates the token reference without displaying its value.
5. SDD 007 conducts local pairing approval.
6. A readable test message is sent and its receipt is committed.
7. Status becomes READY.

### 5.3 Fresh selected-session journey

1. The user chooses session.
2. SDD 009 supplies current session names and internal IDs.
3. The user chooses by visible name.
4. The runtime stores the internal ID privately and preserves the visible name for status.
5. A test turn is accepted and receipted.
6. Status becomes READY. No pin action is performed.

### 5.4 Both-mode journey

Each route is configured and tested separately. Aggregate READY is returned only when both are ready. One passing route and one failing route remain independently visible.

### 5.5 Repeat and repair journeys

A repeat run reuses valid configuration, pairing, selection, recommendations, outbox rows, and receipts. A partial run resumes at the first unmet prerequisite. A cancelled run preserves every committed step. A route change affects future enqueue eligibility and runs a new route test; it does not erase history.

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 Readiness input

- operationScope: harvest, delivery, telegram_task, status, or onboarding
- optional requestedRoutes: telegram, session, or both
- current package version
- current time from the injected clock
- read-only route adapter probes

Readiness never requires a secret value in its returned model.

### 6.2 Readiness output

~~~json
{
  "schemaVersion": 1,
  "observedAt": 0,
  "status": "READY",
  "reasonCodes": [],
  "nextActions": [],
  "routeMode": "both",
  "routes": {
    "telegram": {"selected": true, "state": "READY", "reasonCodes": []},
    "session": {"selected": true, "state": "READY", "reasonCodes": []}
  },
  "storage": {
    "schemaVersion": 1,
    "state": "READY"
  },
  "changed": false
}
~~~

Timestamps are UTC Unix milliseconds. The status model never contains a token, pairing code, Telegram identity, chat identity, session ID, provider response body, absolute machine path, or raw exception.

### 6.3 Preconditions

- Path resolution from SDD 002 succeeds for any mutation.
- Only one onboarding mutation run owns the runtime lock.
- A backup or migration recovery state is handled before route changes.
- Interactive user choices are confirmed before durable configuration changes.

### 6.4 Successful postconditions

- Core storage is initialized at the current supported schema.
- routeMode is durable.
- Every selected route has a durable configuration state.
- Every selected route has a current successful test receipt.
- A successful onboarding run is recorded.
- Readiness recomputation returns READY.

## 7. Public operations, commands, and events

The logical command name is gorombo-skill-harvester. Packaging may wrap it, but the following verbs and result contracts are stable.

| Operation | Required behavior |
|---|---|
| gorombo-skill-harvester status --json | Read-only readiness output using the schema in 6.2 |
| gorombo-skill-harvester onboard | Interactive inspect, plan, apply, pair or select, test, and verify |
| gorombo-skill-harvester onboard --route telegram | Select Telegram and preserve unrelated session history |
| gorombo-skill-harvester onboard --route session | Select a Codex session and preserve unrelated Telegram history |
| gorombo-skill-harvester onboard --route both | Select and verify both routes |
| gorombo-skill-harvester route test ROUTE | Perform one bounded test and store its receipt |
| gorombo-skill-harvester route disable ROUTE | Stop future enqueue for that route after confirmation; preserve history |
| gorombo-skill-harvester telegram unpair | Invoke SDD 007 unpair after confirmation |
| gorombo-skill-harvester session select | Invoke SDD 009 discovery and selection |
| gorombo-skill-harvester doctor --json | Read-only expanded checks with redacted evidence |

Non-interactive onboarding is allowed only with explicit non-secret choices and preexisting secret values. It never accepts a bot token as a command-line argument. If a required choice or local approval is absent, it exits without guessing.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Requested operation succeeded; status may be READY |
| 2 | NEEDS_ONBOARDING |
| 3 | DEGRADED |
| 4 | RECOVERY_REQUIRED |
| 5 | User cancelled without unsafe partial mutation |
| 64 | Invalid input or unsupported combination |
| 70 | Internal operation failed; status contains a safe reason |

Stable onboarding events are onboarding.inspected, onboarding.step_started, onboarding.step_committed, onboarding.route_tested, onboarding.cancelled, and onboarding.completed. Event bodies use IDs and reason codes, never secrets.

## 8. Data and file contracts

SDD 004 owns physical tables. This specification requires these logical records:

- product_settings: routeMode, config version, content policy version
- onboarding_runs: ID, state, requested route mode, started and completed times, safe reason
- route_configurations: route, selected flag, configuration revision, state
- route_test_receipts: route, configuration revision, test generation, accepted time, safe receipt reference
- operational_events: onboarding and readiness transitions

A route test receipt is current only when its configuration revision equals the active route configuration revision. Historical receipts remain immutable.

## 9. State machines

### 9.1 Public readiness

~~~text
NEEDS_ONBOARDING -> READY
NEEDS_ONBOARDING -> RECOVERY_REQUIRED
READY -> DEGRADED
READY -> RECOVERY_REQUIRED
DEGRADED -> READY
DEGRADED -> NEEDS_ONBOARDING
DEGRADED -> RECOVERY_REQUIRED
RECOVERY_REQUIRED -> NEEDS_ONBOARDING or READY only after explicit recovery succeeds
~~~

MIGRATION_REQUIRED is not a fifth public state. A safe pending migration maps to NEEDS_ONBOARDING with reason migration_required. An unsafe or uncertain migration maps to RECOVERY_REQUIRED. BLOCKED is not a public state; unsafe blocking conditions map to RECOVERY_REQUIRED.

### 9.2 Onboarding run

~~~text
INSPECTING
  -> PLANNED
  -> WAITING_FOR_SECRET
  -> WAITING_FOR_ROUTE_CONFIGURATION
  -> INITIALIZING_STORAGE
  -> VERIFYING_ROUTES
  -> COMPLETED

Any nonterminal state -> CANCELLED
Any unsafe invariant failure -> RECOVERY_REQUIRED
~~~

Steps that do not apply are recorded as skipped with a reason. CANCELLED is an operation result, not a readiness state.

### 9.3 Route readiness

A selected route has one of UNCONFIGURED, CONFIGURED, VERIFYING, READY, DEGRADED, or RECOVERY_REQUIRED. An unselected route is DISABLED. DISABLED schedules no delivery work and does not delete history.

## 10. Algorithms

### 10.1 Readiness algorithm

1. Resolve named paths without creating them for a read-only status call.
2. If the Codex root cannot be resolved, return NEEDS_ONBOARDING.
3. If containment, ownership, database integrity, or schema certainty fails, return RECOVERY_REQUIRED.
4. If owned state is absent, return NEEDS_ONBOARDING.
5. Validate config without reading secret values into output.
6. Evaluate core storage.
7. Evaluate only routes selected by routeMode.
8. During initial setup, any missing route prerequisite returns NEEDS_ONBOARDING.
9. After an earlier READY state, a temporary selected-route failure returns DEGRADED.
10. Return READY only when core and all selected routes are READY.

### 10.2 Onboarding algorithm

1. Acquire the onboarding mutation lock.
2. Run readiness and persist an onboarding run.
3. Build a plan containing only missing or explicitly changed steps.
4. Show the plan and obtain required user choices.
5. Create owned paths through SDD 002.
6. Initialize or migrate storage through SDD 004.
7. Persist non-secret route selection.
8. Configure each selected route through its adapter.
9. Execute and receipt one test per selected route.
10. Recompute readiness from durable state.
11. Commit COMPLETED only if aggregate status is READY.
12. Release the lock in a finally path.

## 11. Concurrency, transactions, locks, and idempotency

- One runtime mutation owner holds the lock defined by SDD 004 and SDD 010.
- Status and doctor are read-only and may run concurrently.
- Every onboarding step has an idempotency key: onboardingRunId plus step name plus configuration revision.
- A repeated completed step returns its stored result after revalidation.
- Route configuration changes increment only that route's revision.
- Test receipts are unique by route plus configuration revision plus test generation.
- Cancellation waits for the active transaction to finish or roll back.
- The runtime never deletes another process's lock or wake endpoint merely because a connection failed.

## 12. Error, retry, timeout, cancellation, and crash behavior

- Missing secret: NEEDS_ONBOARDING, reason telegram_token_missing, next action names TELEGRAM_BOT_TOKEN.
- Invalid secret: NEEDS_ONBOARDING during initial setup or DEGRADED after prior readiness; no value is echoed.
- Pairing expired or rejected: remain at the pairing step; completed storage work remains.
- Session missing during setup: remain at session selection.
- Test timeout: store a safe failed attempt; do not claim READY.
- Database busy: bounded retry under SDD 004; then return a safe busy reason.
- Ctrl-C or agent cancellation: stop starting new steps, let the active atomic step settle, record CANCELLED, and preserve committed work.
- Crash after a committed step: the next run reads the step record and resumes.
- Crash before a commit: no completed step is inferred.

## 13. Security, authorization, privacy, redaction, and permissions

- Secrets are supplied only through the private environment contract in SDD 002.
- Route choice is non-secret; route identities and session IDs are private.
- Local pairing approval is mandatory before Telegram private behavior.
- An unpaired Telegram identity cannot create a task.
- Status exposes visible session name only when safe; it never exposes the internal ID.
- Onboarding transcripts use stable reason codes and safe receipt references.
- All created paths use SDD 002 permissions.
- Destructive reconfiguration requires explicit confirmation and never implies data deletion.

## 14. Observability, status, health, and logs

Required reason codes include codex_root_unresolved, state_missing, config_invalid, migration_required, storage_corrupt, route_selection_missing, telegram_token_missing, telegram_pairing_required, telegram_test_failed, session_selection_required, session_missing, session_busy, route_test_required, runtime_lock_busy, and recovery_required.

Status reports per-route pending and dead-letter counts only when SDD 006 can read them safely. A heartbeat is reported only when SDD 010 proves current ownership. Logs record operation IDs, state transitions, durations, and safe error categories.

## 15. Installation, migration, compatibility, backup, and rollback

A clean package install creates package files only. First invocation returns NEEDS_ONBOARDING and creates private runtime files only through confirmed onboarding. Onboarding invokes migration before route setup. Failed migration prevents route mutation. Package rollback to a version that cannot read the current schema returns RECOVERY_REQUIRED and directs the user to the compatible package or a verified backup.

## 16. Test specification

Required unit and integration cases:

1. Fresh Telegram, session, and both mode.
2. Repeat onboarding with byte-for-byte unchanged recommendations and stable route bindings.
3. Cancellation at every onboarding step.
4. Resume from every committed partial state.
5. Change each route independently.
6. One route passes and one fails in both mode.
7. All four public readiness states and no other public status.
8. Secret-shaped values absent from every output.
9. Session selection handoff uses visible name and stores ID only in private state.
10. No automatic pin operation.
11. Concurrent status and single mutation lock.
12. Clean install returns NEEDS_ONBOARDING rather than false READY.

## 17. Objective acceptance evidence

Approval evidence must include:

- isolated runtime tree before and after onboarding;
- database invariant queries for onboarding runs and route revisions;
- redacted transcripts;
- route test receipts;
- exact JSON status fixtures;
- before and after hashes for repeat onboarding;
- cancellation and crash fixture results;
- proof that no pin operation was invoked;
- traceability results for ACC-001 through ACC-007, ACC-040, ACC-047, and ACC-051.

Process exit or a narrative alone is not evidence.

## 18. Unresolved and deferred decisions

- SDD 009 must define the exact App Server calls, duplicate visible-name presentation, confirmation, rename, active-turn, and missing-session behavior. This blocks approval of the real session integration, not the onboarding orchestration contract.
- SDD 007 must define the exact pairing protocol and Telegram test receipt.
- SDD 008 must define task authority and approval gates.
- SDD 010 must define service installation and heartbeat ownership.
- Public package name, license, remote, and final installed executable are later release gates.

## 19. Cross-spec dependencies and traceability

| Contract | Authoritative spec | Consumers |
|---|---|---|
| Runtime paths and secrets | 002 | 001, 004, 007, 009, 010 |
| Storage transactions | 004 | 001, 003, 006 |
| Outbox route readiness | 006 | 001, 007, 009 |
| Telegram setup | 007 | 001 |
| Session discovery and selection | 009 | 001 |
| Lifecycle lock and heartbeat | 010 | 001 |

### 19.1 Requirement-to-test trace

Test IDs 001-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| PROD-001 | Product boundary and readiness response | 001-T01, 001-T07, 001-T12 | ACC-001 through ACC-003, ACC-007, ACC-051 |
| PROD-002 | Route-mode orchestration | 001-T01, 001-T05, 001-T06 | ACC-001 through ACC-003, ACC-006 |
| PROD-003 | Task entry readiness gate; task semantics remain in SDD 008 | 001-T07 | ACC-007 |
| ONB-001 | Readiness-before-use evaluator | 001-T07, 001-T12 | ACC-007, ACC-051 |
| ONB-002 | First-use onboarding workflow | 001-T01, 001-T03, 001-T04, 001-T12 | ACC-001 through ACC-005, ACC-051 |
| ONB-003 | Route configuration, test, and revision handling | 001-T01, 001-T05, 001-T06, 001-T09 | ACC-001 through ACC-003, ACC-006, ACC-040 |
| ONB-004 | Idempotent resume and mutation ownership | 001-T02, 001-T03, 001-T04, 001-T11 | ACC-004, ACC-005 |

ACC-040 is shared: 001 owns the prompt, confirmation, persistence request, and readiness outcome; 009 owns discovery, identity resolution, naming, and accepted-turn proof.

## 20. Implementation checklist

- [ ] Implement the four-state readiness type.
- [ ] Implement stable reason and next-action codes.
- [ ] Implement read-only status and doctor.
- [ ] Implement the idempotent onboarding step journal.
- [ ] Implement telegram, session, and both route selection.
- [ ] Connect path, storage, Telegram, session, and delivery adapters.
- [ ] Implement cancellation and crash resume.
- [ ] Implement route revisions and current test receipts.
- [ ] Prove repeat onboarding preserves all unrelated state.
- [ ] Add all tests and evidence listed in sections 16 and 17.
- [ ] Obtain approval before product code governed by this specification is written.
