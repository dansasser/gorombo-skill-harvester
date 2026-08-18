# Gorombo Skill Harvester project expectations

## 1. Authority and use

This document turns the confirmed project decisions into requirement IDs that later specifications and tests must trace.

- Confirmed means the user has chosen the behavior.
- Working choice means an assistant-proposed option used for planning and still subject to SDD approval.
- Open gate means the affected specification cannot be approved until the choice is made.
- Later means deliberately outside the first working implementation.

When this file conflicts with decision-register.md, resolve the conflict before code. Do not silently reinterpret either document.

## 2. Product expectations

### PROD-001 - One public product

Gorombo Skill Harvester is one public skill product combining skill harvesting with alert delivery.

Acceptance evidence:

- the public package presents one product identity;
- the skill workflow reaches both harvesting and configured delivery;
- installation documentation describes one onboarding flow.

### PROD-002 - First implementation routes

The first working implementation supports Telegram, a selected Codex session, or both. Other messaging services are later work.

Acceptance evidence:

- onboarding exposes exactly these three route selections;
- each route works alone;
- both mode records independent results for both routes;
- no first-release documentation claims Discord, WhatsApp, or another service is implemented.

### PROD-003 - Telegram tasks

The paired Telegram user can submit tasks, not only receive alerts.

Acceptance evidence:

- an approved identity can create a durable task;
- an unpaired identity cannot create a task;
- the user receives readable progress or status and a final result or actionable error;
- restart does not silently discard an accepted task.

## 3. Path, state, and secret expectations

### PATH-001 - Relative project paths

Every project-owned path stored in tracked files is relative to the skill or project root. Reusable artifacts do not contain a developer machine path.

### PATH-002 - Relative runtime paths

Runtime paths are derived from a discovered Codex root. Gorombo-owned mutable state is placed beneath <CODEX_HOME>/.gorombo/.

### PATH-003 - One path authority

One implementation component owns Codex-root resolution, joining, normalization, containment checks, and creation of owned directories. Other components request named paths from it.

Acceptance evidence for PATH-001 through PATH-003:

- path tests cover configured and fallback Codex roots;
- traversal and escape attempts are rejected;
- a repository scan finds no developer drive, user-home, bot token, chat ID, or session ID;
- clean-install tests show all owned mutable data beneath the resolved .gorombo directory.

### SEC-001 - No committed secret

No real token, key, pairing code, Telegram identity, or session ID is committed. The public repository provides placeholder variable names only.

### SEC-002 - Private environment file

The documented environment file is <CODEX_HOME>/.gorombo/.env. It is runtime state, not a file inside the installed skill directory.

### SEC-003 - Redaction

Status, logs, database diagnostics, provider errors, recommendations, task output, test fixtures, and crash reports must not reveal a secret.

Acceptance evidence:

- secret-shaped test values are absent from every captured output;
- missing and invalid credentials produce actionable messages naming the variable, not its value;
- file-permission behavior is defined and verified for every supported environment.

## 4. Onboarding expectations

### ONB-001 - Readiness before use

Before harvest, delivery, or task operation, the agent invokes a readiness check. The result is READY, NEEDS_ONBOARDING, DEGRADED, or RECOVERY_REQUIRED with non-secret reasons.

### ONB-002 - First-use creation

When onboarding is needed, the product creates only the private directories, database, recommendation storage, and configuration metadata it owns. It explains where the user must place required secret values.

### ONB-003 - Route configuration

Onboarding lets the user choose Telegram, a selected Codex session, or both, and performs a test delivery through each chosen route.

### ONB-004 - Idempotence

Re-running onboarding preserves valid pairing, session selection, recommendation files, and delivery state unless the user explicitly changes them.

Acceptance evidence:

- fresh-state tests reach READY;
- repeat onboarding produces no unintended reset;
- partial setup resumes at the missing step;
- changing one route does not erase the other route.

## 5. Harvester expectations

### HAR-001 - Durable completion intake

A completion event is persisted with stable correlation identity before assessment begins.

### HAR-002 - Exactly one assessment outcome

Assessment records exactly one of not-a-skill, extend-existing, or propose-new for each correlation identity.

### HAR-003 - Durable readable recommendation

A propose-new outcome creates a durable, owner-visible Markdown recommendation and matching database record before any route is enqueued.

### HAR-004 - Direct alert handoff

The harvester directly enqueues delivery after the recommendation becomes owner-visible. It does not poll its own completion database to discover finished recommendations.

### HAR-005 - Replay and restart

Replayed input and restart at any durable boundary do not silently lose a recommendation or create an unintended second proposal.

Acceptance evidence:

- all three decisions have unit and integration tests;
- replay tests prove stable correlation behavior;
- fault tests terminate after every commit and file-visibility boundary;
- recommendation bytes and database digest agree.

## 6. Recommendation and alert expectations

### MSG-001 - Useful words

A user alert is not raw internal JSON and is not a digest-only message. It states the proposed skill name, why it is recommended, when it should be used, and the suggested procedure.

### MSG-002 - Safe bounded content

Alert content is rendered from an explicit safe model, is bounded for the destination, and excludes raw private evidence unless the approved content specification explicitly allows a redacted summary.

### MSG-003 - Stored and delivered consistency

The stored recommendation is the source for route messages. Route-specific formatting may shorten it, but must preserve the proposed name and actionable meaning.

Acceptance evidence:

- golden tests verify complete human-readable messages;
- Telegram length behavior is tested;
- selected-session messages identify the recommendation record;
- private or secret-shaped evidence is redacted.

## 7. Delivery expectations

### DEL-001 - Independent route state

Telegram and selected-session routes have separate outbox rows, attempts, receipts, retry state, and terminal status.

### DEL-002 - Event-driven wakeup

A committed enqueue wakes the relevant route worker. Timers may serve scheduled retry or lease expiry, but they do not scan the Harvester database for newly completed work.

### DEL-003 - Durable recovery

Claims, leases, bounded retry, dead-letter status, and deliberate replay survive restart.

### DEL-004 - Honest delivery guarantee

The product documents the external-send ambiguity where provider acceptance occurs before the local receipt commit. It does not claim strict exactly-once delivery without provider support.

Acceptance evidence:

- both mode proves one route can succeed while the other retries or fails;
- future retry and lease expiry wake automatically;
- restart recovers queued and expired in-flight rows;
- dead-letter records are visible and can be deliberately replayed.

## 8. Telegram expectations

### TEL-001 - Local pairing approval

After the user contacts the bot, the runtime generates a short-lived pairing code and requires local approval before binding the Telegram identity.

### TEL-002 - Identity authorization

Only the paired user and chat identity can submit tasks or receive private route behavior. Telegram topic routing is not required.

### TEL-003 - Useful alerts and tasks

The same route sends human-readable recommendation alerts and accepts authorized tasks.

### TEL-004 - Credential handling

The bot token is read from private runtime configuration and is never returned in status, logs, or messages.

Acceptance evidence:

- pairing, expiry, wrong-code, reuse, restart, unpair, and re-pair tests pass;
- unpaired updates are rejected before task persistence;
- test delivery and task execution work after restart.

## 9. Selected Codex session expectations

### SES-001 - Name for the user, ID internally

The user chooses and finds the destination by its user-facing session name. The implementation persists the long session ID internally.

### SES-002 - No automatic pinning

The product does not automatically pin the selected session. The user may pin it in Codex.

### SES-003 - Busy and missing session behavior

If the selected session has an active turn, delivery remains queued until a usable completion event. If the session no longer exists, status requires reselection and preserves the undelivered recommendation.

Acceptance evidence:

- selection and test delivery use current session discovery;
- naming is visible in Codex search;
- active-turn, restart, rename, inaccessible, and deleted-session cases are tested;
- a message is marked sent only after the integration accepts the turn and local receipt state is stored.

## 10. Lifecycle and operational expectations

### OPS-001 - Always on

The runtime can be installed to start automatically and return after host restart without requiring an open terminal.

### OPS-002 - Status, health, and heartbeat

Read-only status reports configuration, selected routes, worker health, schema version, pending/dead-letter counts, and last heartbeat without secrets.

### OPS-003 - Controlled operations

Start, stop, restart, test, backup, restore, replay, update, and uninstall-data choices are documented and return objective results.

Acceptance evidence:

- process restart and host-reboot tests restore service;
- heartbeat becomes stale when the worker stops;
- shutdown releases owned resources;
- failed migration and incompatible schema states are visible and recoverable.

## 11. Planning and release expectations

### SDD-001 - Specifications before product code

Detailed specifications are created under docs/specs/ and approved before the governed product code is written.

### SDD-002 - Traceability

Every first-release requirement maps to an owning specification, implementation component, test, and acceptance result.

### REL-001 - Public-package hygiene

Release verification covers package structure, skill validation, secret and path scans, clean install, update, migration, recovery, and public documentation.

Current publication gates for public identity confirmation, remote, license, retention, retry defaults, and task authority remain in decision-register.md. Selected-session setup and the version 1 recommendation schema are implemented baselines.
