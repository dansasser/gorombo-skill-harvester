# Gorombo Skill Harvester SDD roadmap

## 1. Purpose

After the implementation plan is accepted, create the detailed specifications below under docs/specs/. These are the working development contracts. They must make the product work hypothetically on paper before product code is created.

This roadmap does not create docs/specs/ or product code. It defines what those later documents must contain, their dependencies, and their approval gates.

## 2. Required structure for every specification

Every SDD document must contain:

1. title, status, owner, reviewers, and revision history;
2. governing decisions and requirement IDs;
3. purpose, goals, and explicit non-goals;
4. terminology and entities;
5. user journeys and system actors;
6. inputs, outputs, preconditions, and postconditions;
7. exact APIs, commands, events, and configuration fields;
8. exact data structures, database schema, indexes, and file formats;
9. state machines and allowed transitions;
10. algorithms and ordered processing steps;
11. concurrency, transaction, lock, lease, and idempotency behavior;
12. errors, retry, timeout, cancellation, and crash recovery;
13. security, authorization, privacy, redaction, and permissions;
14. observability, status, health, metrics, and logs;
15. installation, migration, compatibility, backup, and rollback effects;
16. unit, integration, migration, fault-injection, end-to-end, and acceptance tests;
17. objective acceptance evidence;
18. unresolved decisions and deferred work;
19. cross-spec dependencies and traceability; and
20. implementation checklist in dependency order.

A specification is not approved while a behavior-changing choice remains implicit.

## 3. Specification set

### 001 - Product contract and onboarding

Planned file: docs/specs/001-product-and-onboarding.md

Purpose:

Define the public product boundary and the complete first-use, repeat-use, reconfiguration, and readiness experience.

Owns:

- PROD-001 through PROD-003;
- ONB-001 through ONB-004;
- READY, NEEDS_ONBOARDING, DEGRADED, and RECOVERY_REQUIRED semantics;
- route choice between Telegram, selected Codex session, and both;
- user-visible prompts, confirmations, test delivery, and setup summary.

Must decide:

- exact command and skill entry behavior;
- interactive and non-interactive inputs;
- when a route is considered configured and ready;
- partial onboarding recovery;
- reconfiguration, unpairing, and reselection behavior;
- status result schema and exit behavior.

Dependencies: decision register and this planning package.

Exit evidence:

Fresh, repeat, partial, changed-route, cancelled, and recovery onboarding scenarios are fully specified and mapped to tests.

### 002 - Paths, configuration, and secrets

Planned file: docs/specs/002-paths-config-and-secrets.md

Purpose:

Define portable project paths, runtime Codex-root discovery, the .gorombo layout, configuration parsing, secret references, file permissions, and redaction.

Owns:

- PATH-001 through PATH-003;
- SEC-001 through SEC-003;
- .env.example behavior;
- containment and traversal rejection;
- secret rotation and removal behavior.

Must decide:

- exact Codex-root resolution order;
- exact private directory and file names;
- environment variable names;
- configuration schema and precedence;
- supported-environment permission behavior;
- redaction patterns and diagnostic boundaries.

Dependencies: 001 product and onboarding.

Exit evidence:

Path tables, configuration schema, permission table, redaction rules, threat cases, and clean-root tests are exact.

### 003 - Harvester core

Planned file: docs/specs/003-harvester-core.md

Purpose:

Define completion intake, bounded evidence, stable correlation, assessment, all three decisions, replay, recommendation creation, owner visibility, direct route enqueue, and completion acknowledgement.

Owns:

- HAR-001 through HAR-005;
- not-a-skill, extend-existing, and propose-new contracts;
- evidence inputs and limits;
- decision determinism and versioning;
- direct event handoff without completion polling.

Must decide:

- completion event schema and source adapters;
- correlation-key construction;
- assessment inputs and output schema;
- existing-skill lookup and extension behavior;
- required recommendation fields;
- acknowledgement boundary.

Dependencies: 002 paths/config/secrets; preliminary storage model from 004 must be reviewed jointly.

Exit evidence:

Exact sequence diagrams, outcome state machine, evidence limits, replay rules, and fault cases cover every durable boundary.

### 004 - Storage schema and migrations

Planned file: docs/specs/004-storage-schema-and-migrations.md

Purpose:

Define the complete durable model for events, assessments, recommendations, pairings, selected sessions, tasks, deliveries, attempts, receipts, migrations, operational errors, and recovery.

Owns:

- schema versioning;
- table, column, constraint, index, and foreign-key definitions;
- transaction boundaries;
- database and recommendation-file consistency;
- migration lock, backup, upgrade, downgrade, and interrupted migration behavior;
- retention hooks without inventing a retention default.

Must decide:

- exact database engine integration and settings;
- identifier formats;
- time representation;
- write concurrency model;
- backup and restore format;
- open retention choices.

Dependencies: 002 and joint design with 003, 006, 007, 008, and 009.

Exit evidence:

A complete schema, migration graph, transaction table, invariants, and old-version fixtures can be implemented without schema invention.

### 005 - Recommendation and alert content

Planned file: docs/specs/005-recommendation-and-alert-content.md

Purpose:

Define the durable Markdown recommendation and the safe, useful route messages derived from it.

Owns:

- MSG-001 through MSG-003;
- proposed skill name, reason, when-to-use, suggested procedure, evidence summary, and stable record reference;
- redaction and bounding before persistence;
- Telegram and selected-session rendering behavior;
- wording for extend-existing when it is surfaced.

Must decide:

- final mandatory recommendation schema;
- Markdown template;
- safe evidence-summary policy;
- route size limits and truncation rules;
- whether any non-propose-new outcomes notify the user.

Dependencies: 003 and 004.

Exit evidence:

Golden recommendation and alert examples cover normal, long, unsafe, missing-field, and route-specific cases. A raw internal JSON object cannot pass the renderer contract.

### 006 - Delivery outbox and recovery

Planned file: docs/specs/006-delivery-outbox-and-recovery.md

Purpose:

Define route-neutral durable delivery, direct wakeup, per-route state, claims, leases, retry, external receipts, dead letters, deliberate replay, and crash recovery.

Owns:

- DEL-001 through DEL-004;
- enqueue transaction;
- event wake mechanism;
- scheduled retry and lease-expiry timers;
- independent both-mode outcomes;
- the external acceptance/local receipt ambiguity.

Must decide:

- exact outbox and attempt states;
- claim and lease algorithm;
- retry schedule and dead-letter threshold open gate;
- provider result classification;
- replay identity and operator command;
- shutdown and recovery order.

Dependencies: 004 and 005.

Exit evidence:

State tables and fault matrix prove expected behavior before, during, and after every transaction and external call. No design depends on polling the Harvester completion database.

### 007 - Telegram pairing and alert delivery

Planned file: docs/specs/007-telegram-pairing-and-alerts.md

Purpose:

Define bot startup, update receipt, local pairing-code approval, identity authorization, alert send, provider errors, unpairing, and test delivery.

Owns:

- TEL-001, TEL-002, and TEL-004;
- bot-token reference;
- paired user/chat identity;
- pairing code lifecycle;
- no Telegram topic requirement;
- Telegram route receipt mapping.

Must decide:

- exact Bot API update transport;
- pairing code entropy, lifetime, attempt limit, and one-time use;
- local approval command;
- authorization record and revocation;
- message splitting and formatting;
- rate-limit and provider failure handling.

Dependencies: 001, 002, 004, 005, and 006.

Exit evidence:

Pair, expire, wrong code, reuse, restart, unpair, re-pair, unauthorized update, alert success, rate limit, timeout, and ambiguous-send cases are exact.

### 008 - Telegram task execution

Planned file: docs/specs/008-telegram-task-execution.md

Purpose:

Define how an authorized Telegram update becomes a durable task, how it is submitted to Codex, how progress and final results return, and how approvals and restart work.

Owns:

- PROD-003 and TEL-003 task behavior;
- task identity and state;
- task-session binding;
- progress reduction;
- cancellation and final result;
- explicit action-approval boundary.

Must decide:

- supported task input forms and commands;
- which actions require approval;
- task execution/session selection;
- queue and concurrency limits;
- progress update cadence;
- cancellation, timeout, retry, and restart semantics.

Dependencies: 002, 004, 006, and 007. It must align with 009 where Codex sessions are shared.

Exit evidence:

Authorized, unauthorized, queued, running, approval-required, cancelled, failed, restarted, and completed task cases have exact state transitions and user messages.

### 009 - Selected Codex session delivery

Planned file: docs/specs/009-codex-session-delivery.md

Purpose:

Define session discovery, user-facing selection and naming, internal-ID persistence, validation, active-turn handling, turn submission, receipt recording, and reselection.

Owns:

- SES-001 through SES-003;
- selected-session test delivery;
- search-visible name behavior;
- no automatic pinning;
- missing, renamed, inaccessible, and busy session states.

Must decide:

- exact onboarding interaction and name confirmation;
- App Server request and notification contracts;
- selection ambiguity behavior;
- active-turn completion wakeup;
- delivery turn content and metadata;
- accepted-turn receipt and recovery.

Dependencies: 001, 002, 004, 005, and 006.

Exit evidence:

Current discovery, selection, test send, busy queue, restart, rename, deletion, reselection, provider error, and ambiguous acceptance are fully specified.

### 010 - Lifecycle, health, and operations

Planned file: docs/specs/010-lifecycle-health-and-operations.md

Purpose:

Define long-running startup, automatic restart, ownership, wake endpoint, graceful shutdown, recovery, status, health, heartbeat, logging, backup, restore, and operator commands.

Owns:

- OPS-001 through OPS-003;
- no-open-terminal operation;
- worker ownership and stale-owner handling;
- startup ordering and shutdown ordering;
- operational diagnostics and redaction.

Must decide:

- lifecycle mechanism for every supported environment;
- exact health and heartbeat schemas;
- local wake endpoint and permissions;
- log location, format, rotation, and retention gate;
- backup, restore, update, and uninstall-data behavior.

Dependencies: 002, 004, 006, 007, 008, and 009.

Exit evidence:

Start, double-start, stop, forced termination, restart, host reboot, stale heartbeat, stale lock, backup, restore, incompatible schema, and diagnostic cases are exact.

### 011 - Plugin packaging and installation

Planned file: docs/specs/011-plugin-packaging-and-installation.md

Purpose:

Validate the working choice to package Gorombo Skill Harvester as a public Codex plugin containing the skill and runtime.

Owns:

- package tree and relative launch paths;
- plugin and skill metadata;
- dependency/runtime requirements;
- install, update, rollback boundary, and uninstall;
- separation of package files from .gorombo state;
- public name, repository, and license gates.

Must decide:

- final public identity;
- final implementation language and build output;
- plugin manifest and optional MCP configuration;
- dependency lock and supported versions;
- exact installer authority and lifecycle handoff;
- whether uninstall retains private state by default.

Dependencies: all functional specs, especially 001, 002, and 010.

Exit evidence:

A clean machine flow, update flow, failed-update recovery, uninstall flow, package validator, and skill validator are fully specified with exact files.

### 012 - Test, security, and release verification

Planned file: docs/specs/012-test-security-and-release.md

Purpose:

Define the executable verification system and release gate for the public package.

Owns:

- SDD-001, SDD-002, and REL-001;
- requirement-to-test traceability;
- unit, integration, migration, fault, end-to-end, security, and packaging suites;
- secret and path scans;
- release evidence record.

Must decide:

- supported test environments;
- required coverage and static checks;
- test credential and fake-provider policy;
- release artifact format;
- compatibility matrix;
- security reporting and maintainer process.

Dependencies: 001 through 011.

Exit evidence:

Every acceptance-matrix row has an owning automated or explicitly controlled test, expected artifact, pass rule, and release blocker rule.

## 4. Dependency order

Recommended drafting order:

1. draft 001 and 002;
2. co-design 003, 004, and 005;
3. define 006 from their durable boundaries;
4. draft 007 and 009 in parallel against 006;
5. draft 008 after pairing and shared Codex contracts are stable;
6. draft 010 after all worker lifecycles are known;
7. draft 011 after runtime boundaries are stable;
8. finish 012 after every other spec exposes its tests and evidence.

A downstream draft may identify a missing upstream rule. Update and reapprove the upstream spec rather than burying the rule downstream.

## 5. Review gates

### Gate A - product coherence

Approve 001 and 002. Confirm user flow, path rule, private state, secret handling, and route choices.

### Gate B - durable Harvester coherence

Approve 003, 004, 005, and 006 together. Confirm no loss, no completion polling, useful safe messages, and restart behavior.

### Gate C - integration coherence

Approve 007, 008, and 009. Confirm pairing, authorization, task authority, selected-session delivery, and both-mode independence.

### Gate D - operational coherence

Approve 010 and 011. Confirm automatic startup, health, recovery, packaging, update, and public/private file separation.

### Gate E - build authorization

Approve 012 and the complete traceability review. Only then begin governed product code.

## 6. Spec change control

A spec change that alters a confirmed decision requires an explicit product decision first. Update decision-register.md, project-expectations.md, acceptance-matrix.md, the implementation plan, and every affected spec in the same review.

A spec may refine a working choice. It must record the evidence and remove the old ambiguity. Deferred items remain visible and may not be advertised as implemented.
