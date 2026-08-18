# Gorombo Skill Harvester acceptance matrix

## 1. Purpose

This matrix defines end-to-end evidence expected before the first working implementation is complete. Later specifications may add lower-level tests, but they may not remove a confirmed scenario without an explicit decision change.

Evidence means an independently inspectable result: exact files, database rows, provider or App Server receipts, captured redacted output, process state, or test records. Process exit alone and implementation narrative are not sufficient.

The v0.1 baseline excludes the rows labeled Assistant-proposed option. They remain visible as future design candidates and are not public-release requirements for the product the user requested.

## 2. Product and onboarding

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-001 | Fresh Telegram onboarding | Private state is initialized, the token reference is found, local pairing completes, a readable test message arrives, and status is READY. | Isolated runtime tree, migration record, redacted setup transcript, pairing row, provider receipt, READY status. | 001, 002, 004, 007 |
| ACC-002 | Fresh selected-session onboarding | The user selects a session by its visible name, the internal ID is stored privately, a test turn is accepted, and status is READY. | Session-list response, selected name/ID record with private value redacted in reports, accepted-turn receipt, READY status. | 001, 002, 004, 009 |
| ACC-003 | Fresh both-mode onboarding | Both routes pass their own setup and test delivery; failure of either prevents an inaccurate all-ready claim. | Two route records, two receipts, per-route readiness, aggregate status. | 001, 006, 007, 009 |
| ACC-004 | Repeat onboarding | Valid pairing, session selection, recommendations, outbox, and receipts remain unchanged unless the user chooses a change. | Before/after hashes and database invariant query. | 001, 004 |
| ACC-005 | Partial or cancelled onboarding | The product stops safely, reports the exact missing step, and resumes without deleting completed setup. | Partial-state fixtures, non-secret status, resumed completion record. | 001, 002, 004 |
| ACC-006 | Assistant-proposed option: post-onboarding route change | Deferred; v0.1 chooses telegram, session, or both during onboarding. | Not required for the v0.1 baseline. | Future specification |
| ACC-007 | Readiness before operation | Harvest, delivery, and task entry points invoke readiness and return a useful setup or recovery result when not ready. | Entry-point tests and exact readiness response. | 001 |

## 3. Paths and secrets

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-008 | Configured Codex root | Every Gorombo-owned mutable file is created beneath the configured Codex root's .gorombo directory. | Isolated tree inventory and containment assertions. | 002 |
| ACC-009 | Fallback Codex root | The documented fallback resolves without embedding a developer path, and all owned state remains contained. | Path-resolution test for each supported environment. | 002 |
| ACC-010 | Traversal or escape input | Absolute override in reusable config, parent traversal, link/junction escape, and malformed components are rejected before creation. | Negative test table and unchanged outside snapshots. | 002 |
| ACC-011 | Missing or invalid secret | The error names the required configuration field but never its value; status remains non-secret. | Captured outputs scanned against seeded secrets. | 002 |
| ACC-012 | Credential rotation | A changed Telegram token is adopted through the defined restart/reload flow without deleting pairing or recommendation history unless the spec requires re-pairing. | Before/after state and provider test delivery. | 002, 007, 010 |
| ACC-013 | Public-tree hygiene | No tracked file contains a real key, pairing code, user/chat ID, session ID, generated state, or machine-specific path. | Deterministic secret/path scan report over the release tree and history boundary chosen by spec. | 002, 011, 012 |

## 4. Harvester and recommendation

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-014 | not-a-skill outcome | Exactly one durable not-a-skill outcome is recorded; no proposed-skill recommendation or new-skill alert is created. | Completion and outcome rows, absent recommendation and route rows. | 003, 004 |
| ACC-015 | extend-existing outcome | Exactly one durable extension outcome references the existing skill according to the spec; it does not masquerade as a proposed-new result. | Outcome record, existing-skill reference, route behavior defined by content spec. | 003, 004, 005 |
| ACC-016 | propose-new outcome | A durable Markdown recommendation tells the user the proposed skill name, why it is recommended, when to use it, and its suggested procedure. | Exact recommendation file, matching database digest, renderer golden result. | 003, 004, 005 |
| ACC-017 | Raw internal object supplied to alert path | The route renderer produces the approved human-readable message or rejects the unsafe payload; it never sends digest-only internal JSON as the user alert. | Golden and negative renderer tests. | 005 |
| ACC-018 | Private evidence in completion | Secret-shaped, machine-path, and unrelated private evidence is removed or safely summarized before recommendation persistence and delivery. | Seeded evidence, stored bytes, captured route payloads, redaction scan. | 002, 003, 005 |
| ACC-019 | Replayed completion | Reusing the same correlation identity does not create an unintended second assessment, recommendation, or route enqueue. | Stable database counts, identities, and unchanged recommendation hash. | 003, 004, 006 |
| ACC-020 | Direct event handoff | The completion hook durably publishes its event to the private handoff before returning. A filesystem event or startup drain accepts it into SQLite, and making a recommendation owner-visible commits its route rows and wakes route workers without periodic completion scanning. | Handoff file and digest, event-wake and startup-drain traces, SQLite acceptance, route wake observation, and assertion that no completion-poll scheduler exists. | 003, 006, 010 |
| ACC-021 | Stored and delivered consistency | Every route message preserves the name and actionable meaning of the stored recommendation and identifies its stable record. | Recommendation hash/ID and captured route messages. | 005, 006, 007, 009 |

## 5. Durable delivery and recovery

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-022 | Crash at each durable boundary | Restart produces the exact specified retry, deduplication, completion, or recovery-required state with no silent loss. | Fault matrix covering every commit, file visibility, claim, external call, receipt, and acknowledgement boundary. | 003, 004, 006 |
| ACC-023 | Both mode with Telegram failure | Selected-session delivery may succeed while Telegram retries or dead-letters; the two results remain independently visible. | Per-route rows, attempts, receipt, error class, and aggregate status. | 006, 007, 009 |
| ACC-024 | Both mode with session failure | Telegram may succeed while selected-session delivery waits, retries, or requires reselection. | Per-route rows, Telegram receipt, preserved session delivery, status. | 006, 007, 009 |
| ACC-025 | Future retry or lease expiry | A scheduled timer wakes at the due time without an unrelated event and makes the row claimable. | Fake-clock and real-timer integration evidence. | 006, 010 |
| ACC-026 | Disabled route | Disabling a route does not spin a zero-delay timer, consume CPU in a loop, or mutate its queued history unexpectedly. | Fake-clock scheduler test and bounded process metrics. | 006, 010 |
| ACC-027 | Assistant-proposed option: operator replay | Deferred; v0.1 keeps exhausted or recovery-required work visible without a public replay command. | Not required for the v0.1 baseline. | Future specification |
| ACC-028 | External acceptance before receipt commit | The product reports the ambiguous window honestly and follows the specified bounded recovery behavior. | Fault-injected provider acceptance, absent local receipt, restart result, user-visible status. | 006, 007, 009 |
| ACC-029 | Graceful shutdown | Shutdown stops new claims, finishes or safely releases current work, closes database and endpoints, and leaves restartable state. | Process lifecycle trace, lock/endpoint absence or safe ownership state, database checks. | 006, 010 |
| ACC-030 | Competing runtime | A second instance cannot steal or delete an active instance's lock or wake endpoint; stale ownership is recovered only after proof. | Two-process integration test and unchanged active endpoint. | 006, 010 |

## 6. Telegram pairing, alerts, and tasks

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-031 | New pairing | Contact with the bot creates a short-lived code; exact local approval binds the intended user/chat identity once. | Pairing request/approval records with sensitive values redacted in reports. | 007 |
| ACC-032 | Wrong, expired, or reused code | Approval fails safely and does not bind or replace an identity. | Negative pairing tests and invariant queries. | 007 |
| ACC-033 | Restart during pairing | Pending pairing follows the specified persistence/expiry rule and cannot bypass local approval. | Before/after state and clock-controlled result. | 004, 007 |
| ACC-034 | Unpaired Telegram update | The update is rejected before private alert behavior or task persistence. | Authorization trace and absent task/outbox rows. | 007, 008 |
| ACC-035 | Readable Telegram alert | The paired destination receives the approved human-readable recommendation within Telegram limits and without topic routing. | Captured request, provider message ID, paired route receipt. | 005, 007 |
| ACC-036 | Authorized Telegram task | A paired request becomes one durable task, executes through the specified Codex binding, and returns readable progress plus final result. | Update identity, task state history, execution receipt, captured replies. | 008 |
| ACC-037 | Task requiring host approval | The task enters WAITING_APPROVAL, does not act, and is not automatically resumed. The user resolves the host approval and sends the task again. | Durable state transition, readable reply, and proof that the task is not reclaimed or rerun. | 008 |
| ACC-038 | Restart during Telegram task | Accepted queued/running task state is recovered according to spec and reaches a visible terminal or recovery-required state. | Pre-crash state, restart audit, final task/result rows. | 004, 008, 010 |
| ACC-039 | Telegram provider errors | Rate limit, timeout, unauthorized token, malformed response, and ambiguous send are classified, redacted, and handled according to retry policy. | Provider-fake cases, attempts, next due time, status output. | 006, 007 |

## 7. Selected Codex session

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-040 | Select and name destination | Onboarding discovers current sessions, records the chosen visible name and internal ID, and confirms with a test turn. | Discovery result, private selection row, accepted-turn receipt. | 001, 009 |
| ACC-041 | Find destination in Codex | The selected session is visible under the confirmed user-facing name for search. The product performs no automatic pin action. | App Server readback and absence of a pin operation. | 009 |
| ACC-042 | Selected session has active turn | Delivery remains queued, does not conflict with the active turn, and wakes from the defined completion event. | Active-turn fixture, queued row, completion notification, accepted later turn. | 006, 009 |
| ACC-043 | Selected session renamed | Internal ID continuity and user-visible status follow the exact rename rule without silently selecting another session. | Before/after App Server data and selection status. | 009 |
| ACC-044 | Selected session missing or inaccessible | The recommendation remains undelivered, status requires reselection, and a new selection can complete delivery. | Preserved outbox row, recovery status, reselection and final receipt. | 006, 009 |
| ACC-045 | Restart with queued session delivery | Restart restores App Server connection and safely resumes queued or expired in-flight work. | Restart trace, claim state, accepted-turn receipt. | 006, 009, 010 |

## 8. Lifecycle, migration, packaging, and release

| ID | Scenario | Expected result | Required evidence | Owning spec |
|---|---|---|---|---|
| ACC-046 | Automatic startup and host restart | The runtime returns to service without an open terminal and drains recoverable work. | Installed lifecycle state, reboot/restart result, heartbeat, delivery completion. | 010, 011 |
| ACC-047 | Health and heartbeat | Healthy, degraded, stale, and recovery-required conditions are accurate, read-only, and secret-safe. | Status fixtures, heartbeat timestamps, captured redacted output. | 001, 010 |
| ACC-048 | Assistant-proposed option: schema-changing migration | Deferred while v0.1 has only the frozen schema-1 baseline. | Not required until a later schema exists. | Future specification |
| ACC-049 | Assistant-proposed option: interrupted schema-changing migration | Deferred while v0.1 has only the frozen schema-1 baseline. | Not required until a later schema exists. | Future specification |
| ACC-050 | Assistant-proposed option: public backup and restore commands | Deferred; v0.1 reserves private backup storage but exposes no backup or restore command. | Not required for the v0.1 baseline. | Future specification |
| ACC-051 | Clean public install | Installation contains the complete deterministic test suite, verifies it from the installed artifact, creates only declared package and private runtime files, then enters onboarding rather than claiming false readiness. | Packed test inventory, installed-artifact verifier result, before/after filesystem inventory, package validation, readiness result. | 001, 011 |
| ACC-052 | Assistant-proposed option: schema-changing update rollback | Deferred until a later package changes the schema or update contract. | Not required for the v0.1 baseline. | Future specification |
| ACC-053 | Assistant-proposed option: private-data deletion during uninstall | Deferred; v0.1 service uninstall preserves private state and package removal does not delete it. | Not required for the v0.1 baseline. | Future specification |
| ACC-054 | Skill and plugin validation | The final package structure, manifest, skill metadata, relative entry points, and declared dependencies pass their validators. | Validator outputs and artifact inventory. | 011, 012 |
| ACC-055 | Full release traceability | Every confirmed requirement maps to an approved spec, implementation path, test, and passing evidence item; open release gates are closed. | Generated traceability report and release checklist. | 012 |

## 9. Completion audit

Before marking the product complete:

1. run every automated acceptance case in a clean isolated runtime root;
2. run controlled real-integration tests required by the approved Telegram and App Server specs;
3. hash the release artifact and evidence bundle;
4. inspect the Git tree and history boundary required by the release spec for secrets and machine paths;
5. verify no acceptance result relies only on process exit or narrative;
6. record every skipped, failed, flaky, or environment-limited case as a release blocker unless the approved spec explicitly classifies it otherwise;
7. verify docs match observed install, onboarding, operation, recovery, and uninstall behavior; and
8. require an explicit release decision after all open gates are closed.

The product code now exists. npm run verify executes the deterministic and packed-install cases; controlled Telegram, selected-task, and service-host receipts remain explicit publication gates until they are recorded.
