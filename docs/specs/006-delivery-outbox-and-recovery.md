# SDD 006: Delivery outbox and recovery

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester route-neutral delivery
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: direct route fan-out, outbox identity, event wakeup, scheduler, claims, leases, adapter results, bounded retry, receipts, dead letters, deliberate replay, shutdown, and crash recovery
- Approval blocker: the proposed retry schedule and dead-letter threshold require product-owner approval

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification implements DEL-001, DEL-002, DEL-003, and DEL-004.

It owns ACC-023 through ACC-030 and the delivery portions of ACC-003, ACC-006, ACC-019 through ACC-022, ACC-039, ACC-042, ACC-044, and ACC-045.

Confirmed behavior:

1. Telegram and selected-session deliveries have independent durable state.
2. The Harvester directly enqueues after owner visibility.
3. A committed enqueue wakes route work; there is no completion-table polling.
4. Timers are used only for known due retry or lease expiry.
5. Claims, leases, bounded retry, dead letter, and deliberate replay survive restart.
6. External acceptance before local receipt is an honest ambiguous window; strict exactly-once is not claimed.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Turn each owner-visible recommendation into independently recoverable delivery work for every selected route, send outside database transactions, and maintain enough durable state to explain, retry, pause, dead-letter, or deliberately replay every route result.

### 3.2 Goals

- Stable outbox identity and payload version.
- Atomic initial fan-out with recommendation visibility.
- Immediate in-process wake after commit.
- Earliest-due timer with no idle polling.
- Token-fenced claims and receipts.
- Independent success and failure in both mode.
- Bounded retry and visible dead letters.
- Explicit replay that never changes a successful sibling route.
- Safe shutdown and restart.
- Honest ambiguous-acceptance status.

### 3.3 Non-goals

- Telegram-specific error parsing; SDD 007 owns it.
- App Server-specific busy and missing-session parsing; SDD 009 owns it.
- Host service installation or wake-endpoint implementation; SDD 010 owns it.
- Exactly-once delivery without provider idempotency.
- Polling Harvester completion or assessment rows.
- Automatically replaying a dead letter after its terminal decision.

## 4. Terminology

- Outbox row: one recommendation, route, payload version, and delivery generation.
- Generation zero: initial direct fan-out.
- Delivery generation: monotonically increasing deliberate replay generation.
- Integrity gate: non-claimable generation-zero state between visibility commit and post-commit file verification.
- Due row: eligible QUEUED or RETRY_WAIT row whose nextAttemptAt is not later than now, whose recommendation is OWNER_VISIBLE, and whose completion is outside RECOVERY_REQUIRED.
- Claim: atomic transition to SENDING with lease token, owner, expiry, and attempt.
- Lease token: random fencing value required for completion.
- Route adapter: Telegram or session sender returning the result union.
- Accepted: provider or App Server returned its defined acceptance receipt.
- Ambiguous acceptance: call outcome cannot prove whether the external side accepted it.
- Route blocked: credentials, pairing, destination, or reselection prevents sending.
- Dead letter: terminal unsuccessful generation requiring deliberate replay.
- Wake: in-process notification that recomputes due work.
- Scheduler generation: counter that invalidates stale timer callbacks.
- Stable key: recommendation ID, route, payload version, and generation.

## 5. Actors and journeys

- Harvester storage transaction inserts generation-zero rows in INTEGRITY_PENDING.
- Post-commit verifier atomically activates matching rows or pauses them with the owning records in RECOVERY_REQUIRED.
- Dispatcher receives the post-commit wake.
- Route worker claims eligible rows and calls its adapter.
- Adapter returns one typed result.
- Storage fences and records the outcome.
- Status reports per-route state.
- Operator repairs route configuration or deliberately replays a dead letter.

Both-mode example: Telegram may enter RETRY_WAIT while the selected session reaches SENT. The recommendation remains a single owner-visible record with two independent outbox histories.

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 Initial enqueue input

- recommendationId
- immutable canonical content digest
- enabled route snapshot from the visibility transaction
- payloadVersion per route
- createdAt

Preconditions: recommendation file and digest are durable; recommendation is transitioning to OWNER_VISIBLE; route configuration revisions are valid.

Postcondition: exactly one generation-zero row exists per enabled route in non-claimable INTEGRITY_PENDING. After the post-commit digest check, one transaction changes those exact rows to QUEUED with nextAttemptAt equal to activation time, or changes them to PAUSED and marks the owning recommendation and completion RECOVERY_REQUIRED.

### 6.2 Adapter result union

~~~text
accepted(providerReceiptRef, acceptedAt, safeReceipt)
retryable(category, safeDetail)
rateLimited(category, retryAfterAt, safeDetail)
routeBlocked(category, safeDetail)
permanent(category, safeDetail)
ambiguous(category, safeDetail)
~~~

The union is closed. Unknown results are treated as permanent adapter_contract_invalid and never serialized as raw provider output.

### 6.3 Claim output

~~~json
{
  "deliveryId": "out_...",
  "attemptId": "att_...",
  "attemptNumber": 1,
  "route": "telegram",
  "recommendationId": "rec_...",
  "payloadVersion": 1,
  "leaseToken": "opaque-random",
  "leaseExpiresAt": 0
}
~~~

Private route identities are obtained through route repositories after claim and never included in general logs.

### 6.4 Success postconditions

A matching delivery receipt and completed attempt exist; the row is SENT; lease fields are null; terminalAt is set; rendered payload digest is present in safeReceipt; sibling routes are unchanged.

## 7. APIs, commands, events, and configuration

### 7.1 Outbox APIs

~~~text
enqueueInitialRoutes(transaction, recommendation, routes) -> OutboxIds
wake(reason) -> void
nextDue(now) -> DueSchedule | none
claimNext(route, workerId, now) -> Claim | none
completeAccepted(claim, result) -> Receipt
completeFailure(claim, result) -> DeliveryState
recoverExpiredLeases(now) -> RecoveryCount
pauseRoute(route, reason) -> Count
resumeRoute(route, reason) -> Count
replayDeadLetter(deliveryId, replayRequestId, reason) -> NewDelivery
getDelivery(id) -> SafeDeliveryView
listDelivery(filters) -> SafeDeliveryViews
stop(grace) -> ShutdownResult
~~~

### 7.2 Commands

- gorombo-skill-harvester delivery status --json
- gorombo-skill-harvester delivery show OUTBOX_ID --json
- gorombo-skill-harvester delivery replay OUTBOX_ID --reason TEXT
- gorombo-skill-harvester delivery pause ROUTE --reason TEXT
- gorombo-skill-harvester delivery resume ROUTE --reason TEXT
- gorombo-skill-harvester route test ROUTE

Replay generates and prints a replay request ID before mutation. A retry of the same request ID returns the existing replay row.

### 7.3 Stable events

delivery.integrity_pending, delivery.activated, delivery.enqueued, dispatcher.woken, delivery.claimed, delivery.accepted, delivery.retry_scheduled, delivery.paused, delivery.dead_lettered, delivery.ambiguous, delivery.lease_expired, delivery.replayed, dispatcher.started, dispatcher.stopping, and dispatcher.stopped.

## 8. Exact data, identity, and file contracts

SDD 004 owns physical tables. This specification uses:

- delivery_outbox for generation and current state;
- delivery_attempts for every claim;
- delivery_receipts for accepted results;
- delivery_replays for deliberate replay audit;
- route_configurations for eligibility;
- operational_events for safe lifecycle transitions.

Stable key:

~~~text
canonical = canonical JSON UTF-8 bytes of:
{
  "recommendationId": value,
  "route": "telegram" or "session",
  "payloadVersion": integer,
  "deliveryGeneration": integer
}

stableKeyDigest =
  SHA-256("gorombo-skill-harvester/delivery/v1" + NUL + canonical)
~~~

The unique database key in SDD 004 is the authoritative equivalent. A payload-version change requires a new explicit delivery operation or migration; it never mutates an existing row.

Safe error JSON may contain category, provider class, retry-after time, and bounded message code. It may not contain token, endpoint with token, user/chat ID, session ID, payload body, provider body, absolute path, or raw exception.

## 9. State machines

### 9.1 Delivery generation

~~~text
INTEGRITY_PENDING -> QUEUED after successful post-commit digest verification
INTEGRITY_PENDING -> PAUSED and owning records RECOVERY_REQUIRED on mismatch
QUEUED -> SENDING -> SENT
QUEUED -> PAUSED
SENDING -> RETRY_WAIT
SENDING -> PAUSED
SENDING -> DEAD_LETTER
RETRY_WAIT -> SENDING
RETRY_WAIT -> PAUSED
PAUSED(route) -> RETRY_WAIT after explicit route recovery/resume
PAUSED(integrity) -> QUEUED only after explicit integrity recovery re-verifies content
DEAD_LETTER -> new QUEUED generation through explicit replay
~~~

INTEGRITY_PENDING and PAUSED are non-claimable. SENT and DEAD_LETTER are immutable terminal states. Replay never changes the dead-letter row.

### 9.2 Lease

~~~text
UNCLAIMED -> ACTIVE
ACTIVE -> COMPLETED
ACTIVE -> EXPIRED
EXPIRED -> RETRY_WAIT with ambiguous flag
~~~

Expiry never implies external failure or success.

### 9.3 Dispatcher

~~~text
STOPPED -> STARTING -> RUNNING -> STOPPING -> STOPPED
RUNNING -> DEGRADED on adapter or scheduler fault
DEGRADED -> RUNNING after verified recovery
Any unsafe ownership fault -> RECOVERY_REQUIRED
~~~

## 10. Algorithms

### 10.1 Direct fan-out and wake

1. SDD 003/004 visibility transaction inserts one INTEGRITY_PENDING row for each route selected at that transaction.
2. Unique constraints make replayed visibility idempotent.
3. Commit.
4. Reopen no-follow and verify the final recommendation file against its stored digest.
5. On success, one transaction changes the exact INTEGRITY_PENDING rows to QUEUED. On mismatch, one transaction changes them to PAUSED and marks the recommendation and completion RECOVERY_REQUIRED.
6. Only after successful activation, the same runtime calls dispatcher.wake before returning success to the Harvester.
7. wake increments scheduler generation, cancels the owned timer, and starts or joins one pump.
8. If the process crashes between activation commit and wake, startup drain finds the QUEUED rows. If it crashes between visibility commit and verification, startup recovery processes INTEGRITY_PENDING rows before the dispatcher pump.
9. The runtime architecture forbids an unrelated live process from writing outbox rows directly. Operator mutations use the running runtime control boundary or run offline while it is stopped and are drained at next start.

This closes the commit/wake gap without periodic completion polling.

### 10.2 Scheduler

1. On startup, recover expired leases, then run a pump.
2. A pump claims and dispatches currently due work within configured route concurrency.
3. After the pump settles, query:
   - the earliest nextAttemptAt for eligible QUEUED or RETRY_WAIT rows; and
   - the earliest leaseExpiresAt for SENDING rows.
4. Exclude INTEGRITY_PENDING, PAUSED, SENT, DEAD_LETTER, rows whose owning recommendation or completion is RECOVERY_REQUIRED, and rows for a disabled route.
5. If no due time exists, disarm the timer.
6. If due time is not later than now, queue one asynchronous pump; do not recurse.
7. Otherwise arm one timer for the due time. If the runtime timer limit is shorter, arm a bounded checkpoint timer that only recomputes the same known due item.
8. A timer captures scheduler generation and does nothing if stale.
9. Every timer-triggered pump rejection is caught, recorded safely, and rescheduled or escalated; no unhandled promise is allowed.

There is no fixed-interval scan.

### 10.3 Claim

Within one BEGIN IMMEDIATE transaction:

1. Join the owning recommendation and completion, then select one route-enabled row in QUEUED or RETRY_WAIT with nextAttemptAt <= now, recommendation state OWNER_VISIBLE, and completion state outside RECOVERY_REQUIRED, ordered by nextAttemptAt, createdAt, ID.
2. Generate 128 random bits for leaseToken.
3. Set SENDING, leaseOwner, leaseToken, leaseExpiresAt = now + 90000, attemptCount = attemptCount + 1, updatedAt = now.
4. Insert delivery_attempts with attemptNumber equal to the new count.
5. Re-read and return the claim.
6. Commit.

If the conditional update affects zero rows, retry selection once in the pump or return none. Provider work occurs after commit.

### 10.4 Render and send

1. Load and verify owner-visible content, and re-check that the recommendation is OWNER_VISIBLE and the completion is outside RECOVERY_REQUIRED.
2. Render SDD 005 payloadVersion with adapter budget.
3. Obtain private route destination through the typed route repository.
4. Invoke the adapter with a 30000 ms attempt deadline.
5. Convert its response to the closed result union.
6. Commit the result only with matching outbox ID, SENDING state, and leaseToken.
7. Discard stale results after recording a safe operational event.

If step 1 fails integrity verification, do not invoke the adapter. With the matching lease fenced, atomically move the recommendation and completion to RECOVERY_REQUIRED, set the current delivery and every other nonterminal row for that recommendation to PAUSED when not protected by a different active lease, and record a safe `recommendation_integrity` reason. Every active sibling claim re-checks the owning states immediately before provider invocation.

The 90000 ms lease is intentionally longer than the 30000 ms adapter deadline. Version 1 does not renew leases.

### 10.5 Result mapping

| Adapter result | Durable action |
|---|---|
| accepted | Insert receipt, complete attempt accepted, set SENT |
| retryable | Complete attempt, set RETRY_WAIT using retry policy |
| rateLimited | Set RETRY_WAIT at later of policy due and retryAfterAt, subject to approved cap |
| routeBlocked | Set PAUSED, mark route DEGRADED or reselection-required |
| permanent | Set DEAD_LETTER immediately |
| ambiguous | Set ambiguous flag, RETRY_WAIT under bounded policy, warn duplicates possible |
| unknown/throw after sanitization | permanent adapter_contract_invalid or retryable internal category only if explicitly mapped |

### 10.6 Proposed retry and dead-letter policy

This is an Assistant-proposed default requiring approval.

- Maximum total attempts per delivery generation: 8.
- Attempt 1 is immediate.
- After failed attempts 1 through 7, base delays are:
  - 5 seconds
  - 30 seconds
  - 2 minutes
  - 10 minutes
  - 1 hour
  - 6 hours
  - 24 hours
- A failed attempt 8 becomes DEAD_LETTER.
- No random jitter in version 1; deterministic clocks and local scale make it unnecessary.
- A valid provider retry-after defers later than the base, capped at 24 hours. A larger required delay pauses the route with retry_after_exceeds_policy for operator visibility.
- permanent errors do not consume the remaining schedule; they dead-letter immediately.
- routeBlocked pauses without repeatedly consuming attempts.
- ambiguous results consume attempts and follow the same schedule because retry may duplicate.

### 10.7 Lease-expiry recovery

1. Scheduler wakes at the earliest lease expiry.
2. In a write transaction, select expired SENDING rows.
3. Complete their active attempts as lease_expired.
4. Set ambiguousAcceptance = 1 because external acceptance is unknown.
5. If attemptCount is below the approved maximum, set RETRY_WAIT using that attempt's delay.
6. Otherwise set DEAD_LETTER.
7. Clear lease fields and commit.
8. Wake the scheduler.

### 10.8 Deliberate replay

1. Require the original row to be DEAD_LETTER.
2. Require a bounded non-secret reason and replay request ID.
3. If the request ID exists, return its replay row.
4. Compute next generation as max generation for recommendation, route, and payload version plus one.
5. Insert a QUEUED row with replayOfDeliveryId.
6. Insert delivery_replays with replay_request_id equal to the request ID plus original row, new row, actor, reason, and time.
7. Commit and wake.
8. Do not change SENT or other-route rows.

## 11. Concurrency, transactions, locks, leases, and idempotency

- One runtime process owns the outbox dispatcher.
- Default concurrency is one active send per route and at most two total; later configuration may lower but not raise it without load tests.
- One pump promise is shared; concurrent wake calls coalesce and force a post-pump reschedule.
- Unique generation keys prevent duplicate fan-out.
- Claim and completion are token-fenced.
- Attempt numbers are unique per delivery.
- Accepted receipt is unique per attempt.
- Replay request ID is stored in the delivery_replays.replay_request_id primary key and makes uncertain replay commands idempotent.
- Route disable atomically marks eligible QUEUED/RETRY_WAIT rows PAUSED with route_disabled. It does not cancel an already accepted receipt.
- Route resume moves only rows paused for route_disabled and still eligible to RETRY_WAIT due now. Integrity-paused rows require explicit integrity recovery and a fresh digest verification before QUEUED; other pause reasons require their explicit recovery.
- Terminal rows are never reused.

## 12. Error, retry, timeout, cancellation, shutdown, and crash behavior

### 12.1 External acceptance ambiguity

If a provider accepts a message and the process crashes before local receipt commit, restart sees an expired SENDING lease. Recovery marks the attempt ambiguous and may retry. The user may receive a duplicate. Status must say delivery uncertain or duplicate possible; it must not say exactly once.

### 12.2 Shutdown

1. Set STOPPING and reject new claims.
2. Cancel the owned future timer.
3. Allow active adapter calls up to a 30000 ms grace.
4. Commit any result already returned.
5. Ask adapters to abort when supported.
6. Leave unresolved claims SENDING with leases; do not invent a result.
7. Close wake endpoints only when owned.
8. Close storage in a finally block even if dispatcher stop reports an error.
9. Return a safe shutdown result.

### 12.3 Crash matrix

| Crash point | Restart result |
|---|---|
| Before visibility commit | No row; Harvester visibility transaction did not commit |
| After visibility commit before post-commit verification | Startup recovery finds only non-claimable INTEGRITY_PENDING rows and verifies them |
| After integrity mismatch commit | Rows remain PAUSED and owning records remain RECOVERY_REQUIRED |
| After activation commit before wake | Startup drain claims QUEUED row |
| After claim before external call | Lease expiry schedules retry and ambiguity |
| During external call | Lease expiry schedules retry and ambiguity |
| After accepted response before receipt commit | Ambiguous retry; duplicate possible |
| After receipt commit before user-facing status | Row is SENT and readback proves it |
| After retry commit before timer arm | Startup drain or current wake recomputes earliest due |
| After dead-letter commit | Remains terminal until deliberate replay |
| After replay commit before wake | Startup drain or current wake claims new generation |

## 13. Security, authorization, privacy, redaction, and permissions

- Adapters receive secrets through SecretHandle and destinations through private typed records.
- Outbox rows contain recommendation and route references, never bot tokens or destination identities.
- Safe error and receipt JSON use allowlisted fields and bounds.
- Provider response bodies and request URLs are not persisted.
- Operator replay, pause, resume, and route changes require local authorization defined by SDD 010.
- Telegram task actors cannot invoke operator delivery commands unless SDD 008 explicitly grants that authority.
- Wake endpoint validates local ownership and bounded request format.
- A second instance may not unlink an active or inaccessible endpoint merely because a connection probe failed.

## 14. Observability, status, health, and logs

Status reports per route:

- selected and readiness state;
- INTEGRITY_PENDING, QUEUED, SENDING, RETRY_WAIT, PAUSED, SENT, and DEAD_LETTER counts;
- oldest due age;
- next due time;
- active lease count and earliest expiry;
- last accepted time;
- last safe error category;
- ambiguous delivery count.

Metrics include wake count, coalesced wake count, timer arms, claims, results by category, retry delay, lease expiry, dead letter, replay, shutdown duration, and scheduler failure. No payload or private destination is emitted.

## 15. Installation, migration, compatibility, backup, and rollback

- Startup verifies schema, route configuration, and dispatcher ownership before drain.
- Migration may pause claims but does not rewrite terminal delivery history.
- Backups include every outbox, attempt, receipt, and replay row.
- Restore runs lease recovery before sending.
- A payload version unsupported by a rolled-back package is PAUSED and produces RECOVERY_REQUIRED; it is not reformatted with older behavior.
- Service lifecycle and endpoint placement are defined by SDD 010.

## 16. Test specification

1. Atomic one-route and both-route fan-out into INTEGRITY_PENDING, successful activation to QUEUED, and mismatch transition to PAUSED plus RECOVERY_REQUIRED.
2. Replay of Harvester visibility creates no duplicate generation zero.
3. Immediate in-process wake and assertion that no completion poll timer exists.
4. Startup recovery after visibility-before-verification and startup drain after activation-before-wake.
5. Earliest future retry timer fires without unrelated activity.
6. Earliest future lease expiry fires automatically.
7. Disabled route arms no zero-delay timer and consumes no CPU loop.
8. Competing wake calls and pump coalescing.
9. Claim ordering, lease fields, attempt count, and stale-token fencing.
10. Accepted, retryable, rate-limited, blocked, permanent, ambiguous, thrown, and invalid adapter results.
11. Every retry delay and attempt-8 dead letter.
12. Both-mode independent success and failure.
13. External acceptance before receipt commit.
14. Dead-letter replay request idempotency and sibling preservation.
15. Route-pause and integrity-pause recovery behavior.
16. Graceful shutdown and forced lease recovery.
17. Competing runtime cannot remove active lock or endpoint.
18. Socket/client timeout, server error handler, and cleanup-finally behavior.
19. Timer pump rejection is caught.
20. Fault injection at every boundary in section 12.3.

## 17. Objective acceptance evidence

- exact outbox, attempt, receipt, and replay rows;
- fake-clock scheduler traces;
- bounded real-timer integration;
- proof of no completion-poll scheduler;
- per-route both-mode state;
- stale lease and token-fencing queries;
- provider-fake captures with redacted errors;
- dead-letter status and replay audit;
- shutdown and two-process endpoint trace;
- consolidated fault matrix for ACC-022 through ACC-030 and shared cases.

## 18. Unresolved and deferred decisions

- Product owner must approve, change, or reject the proposed 8-attempt schedule, delays, and 24-hour cap.
- SDD 007 must map Telegram responses into the adapter union.
- SDD 009 must map active, busy, missing, renamed, and inaccessible sessions into the union and wake behavior.
- SDD 010 must define the local control and wake endpoint, process ownership, and service shutdown integration.
- Provider-native idempotency keys may strengthen guarantees later when a provider supports them.

## 19. Cross-spec dependencies and traceability

| Contract | Owner | Delivery use |
|---|---|---|
| Route readiness | 001 | eligibility and status |
| Secrets and paths | 002 | adapter handles and endpoint |
| Owner-visible handoff | 003 | enqueue trigger |
| Tables and transactions | 004 | all durable states |
| Safe payload and budget | 005 | render |
| Telegram adapter | 007 | send and classify |
| Session adapter | 009 | send and classify |
| Lifecycle | 010 | ownership, endpoint, shutdown |

### 19.1 Requirement-to-test trace

Test IDs 006-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| DEL-001 | Per-route generation and independent state | 006-T01, 006-T02, 006-T12, 006-T14, 006-T15 | ACC-003, ACC-006, ACC-019, ACC-023, ACC-024 |
| DEL-002 | Commit-triggered wake and earliest-due scheduler | 006-T03 through 006-T08, 006-T19 | ACC-020, ACC-025, ACC-026 |
| DEL-003 | Claims, recovery, replay, and lifecycle | 006-T04 through 006-T06, 006-T09 through 006-T20 | ACC-022 through ACC-030, ACC-039, ACC-042, ACC-044, ACC-045 |
| DEL-004 | Honest provider acceptance guarantee | 006-T10, 006-T13, 006-T20 | ACC-028, ACC-039 |

ACC-022 consolidated fault ownership is shared with SDDs 003 and 004; this document is authoritative from initial outbox row through external call, receipt, retry, dead letter, and replay.

## 20. Implementation checklist

- [ ] Implement stable generation identity and initial fan-out.
- [ ] Implement in-process wake and single pump.
- [ ] Implement earliest-due retry and lease scheduler.
- [ ] Implement atomic token-fenced claim and completion.
- [ ] Implement closed adapter result mapping.
- [ ] Implement approved bounded retry and dead-letter policy.
- [ ] Implement ambiguous acceptance and lease recovery.
- [ ] Implement pause, resume, and deliberate replay.
- [ ] Implement safe shutdown and endpoint ownership handoff.
- [ ] Add all scheduler, provider, crash, and two-process tests.
- [ ] Obtain retry-policy approval before governed product code.
