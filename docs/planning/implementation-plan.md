# Gorombo Skill Harvester implementation plan

## 1. Purpose and planning contract

This document defines Gorombo Skill Harvester before implementation begins. It describes the intended product, boundaries, data flows, files, runtime state, onboarding, delivery routes, recovery behavior, tests, and implementation sequence.

This is an implementation plan, not a code specification. After this plan is accepted, the project will create detailed, multi-page SDD documents under docs/specs/. Those specifications will define exact inputs, outputs, schemas, state transitions, error cases, commands, interfaces, tests, and acceptance evidence. Product code begins only after the affected specifications are approved.

Decision status is maintained in decision-register.md. Confirmed decisions are requirements. Working choices are the planned direction and must be validated in SDD. Open gates remain visible until resolved.

## 2. Product vision

Gorombo Skill Harvester is one public Codex skill product that:

1. observes completed work that may reveal a reusable skill;
2. evaluates that evidence as not a skill, an extension to an existing skill, or a proposed new skill;
3. durably stores the result and a human-readable recommendation;
4. sends a useful alert through Telegram, a selected Codex session, or both;
5. accepts tasks from the paired Telegram user;
6. remains available across process restarts; and
7. keeps all paths portable and all credentials private.

The important product outcome is not an internal decision record. It is a durable recommendation that tells the user what skill is recommended, why it is recommended, when it should be used, and what procedure it should contain.

## 3. Primary user journeys

### 3.1 First use

1. The user installs the public package.
2. The agent invokes the readiness check before trying to harvest, deliver, or accept a task.
3. The readiness check resolves the Codex root and inspects <CODEX_HOME>/.gorombo/.
4. If setup is incomplete, onboarding explains what is missing and creates only the private directories and database state it owns.
5. The user chooses Telegram, a selected Codex session, or both.
6. Telegram setup reads the bot token from the private environment file, starts the bot, presents a pairing code after the user contacts it, and requires local approval of that code.
7. Selected-session setup records the session by its user-facing name and stores the long session ID internally.
8. The product sends a test message through every enabled route.
9. Status becomes READY only when required storage and all selected routes pass their readiness checks.

Onboarding is idempotent. Running it again must preserve valid pairing, session selection, recommendations, and delivery records unless the user explicitly changes them.

### 3.2 Skill recommendation

1. A completion event is accepted with a stable correlation identity and bounded evidence.
2. The harvester persists the event before assessment.
3. Assessment produces exactly one decision: not-a-skill, extend-existing, or propose-new.
4. The decision and evidence digest are committed so restart does not repeat assessment.
5. For propose-new, the recommendation is rendered to Markdown and recorded in the database.
6. Only after the recommendation is durably owner-visible does the harvester enqueue one delivery row for every enabled route.
7. Route workers wake from that enqueue event. They do not poll the Harvester database for newly completed work.
8. Each route records its own result.
9. The completion is acknowledged only after its durable recommendation and required delivery work are scheduled.

### 3.3 Telegram task

1. Telegram receives an update from a paired identity.
2. The authorization gate rejects any unpaired identity before task creation.
3. The task is recorded with a stable identity.
4. The configured Codex task session is resumed or created.
5. The request is submitted and streamed progress is reduced to readable Telegram updates.
6. The final result or actionable error is returned to the paired chat.
7. Task state survives restart and is not silently lost.

The SDD must define which task actions require explicit approval. This plan does not claim that a general model approval setting automatically provides a Telegram approval gate.

### 3.4 Selected Codex session alert

1. Onboarding resolves the selected session and stores its user-facing name plus internal ID.
2. Recommendation enqueue creates a session-route delivery row.
3. The route verifies that the stored session still exists.
4. If the session is idle, the route starts a turn containing the human-readable alert.
5. If a turn is active, delivery remains queued and wakes when the relevant completion event arrives.
6. The user can find the session by name in Codex search and may pin it manually.
7. Delivery is marked sent only after the integration accepts the turn and required receipt state is stored.

## 4. First working implementation scope

The first working implementation includes:

- the public Gorombo Skill Harvester skill;
- package metadata and installable runtime integration;
- first-use onboarding and status;
- private state under <CODEX_HOME>/.gorombo/;
- SQLite schema and migrations;
- Markdown recommendation files;
- all three Harvester decisions;
- durable event, outcome, recommendation, and delivery state;
- human-readable alerts;
- Telegram bot setup, pairing, authorization, alerts, and tasks;
- selected Codex session selection, naming, durable delivery, and active-turn handling;
- Telegram-only, session-only, and both delivery modes;
- event-driven outbox wakeup, bounded retry, leases, and dead-letter visibility;
- always-on lifecycle, restart recovery, status, health, and heartbeat;
- secret redaction;
- tests and public documentation required for installation and operation.

Other messaging services are later work. Route boundaries should permit a later delivery specification, but Discord, WhatsApp, and other services are not part of the first working implementation.

## 5. Packaging direction

The working packaging choice is a Codex plugin containing the public skill and its runtime pieces.

Expected package boundary:

- .codex-plugin/plugin.json for plugin metadata;
- skills/gorombo-skill-harvester/SKILL.md as the concise agent workflow;
- skills/gorombo-skill-harvester/agents/openai.yaml for skill UI metadata;
- runtime source, migrations, scripts, and tests at repository root;
- optional plugin MCP configuration if SDD chooses an MCP server as the runtime entry;
- user documentation at repository root and engineering documentation under docs/.

The skill instructions remain concise. Detailed schemas, recovery procedures, and provider behavior belong in references or engineering documents, not an oversized SKILL.md. The packaging SDD must confirm the exact install, update, and uninstall behavior before scaffolding product files.

## 6. System architecture

### 6.1 Configuration and path resolver

One path module owns all path resolution. It discovers the Codex root, joins approved relative paths beneath it, rejects traversal, and never accepts an embedded machine-specific destination from reusable configuration.

One configuration module loads non-secret settings and secret references. It may read <CODEX_HOME>/.gorombo/.env, but it never returns secrets through status, logs, database diagnostics, or alert payloads.

### 6.2 Onboarding and readiness

The onboarding component compares required state against actual state. It returns one of these product conditions:

- NEEDS_ONBOARDING: required setup has not been completed;
- READY: storage and selected routes are operational;
- DEGRADED: core state is valid but at least one selected route needs attention;
- MIGRATION_REQUIRED: stored schema is older than the running package;
- BLOCKED: state is unsafe or unreadable and automatic continuation would risk loss.

Directory existence alone is not proof of readiness. Readiness includes schema version, writable private state, environment-file presence, route configuration, pairing or session selection, and a successful bounded route check.

### 6.3 Harvester core

The Harvester core accepts bounded completion evidence and produces one durable decision. It owns:

- correlation identity;
- replay protection;
- assessment version;
- decision;
- proposal or extension target;
- evidence summary and digest;
- recommendation rendering input; and
- completion acknowledgement.

The core does not own Telegram or Codex session transport. It emits a durable recommendation-ready event to the delivery core.

### 6.4 Recommendation store

The recommendation store writes two coordinated forms:

- structured database fields used for workflow and queries;
- a human-readable Markdown file used for review and later skill development.

The database row and Markdown file must agree on proposal ID and content digest. A recommendation is not eligible for delivery until the file is durably written and its recorded digest verifies.

### 6.5 Delivery core

The delivery core creates one delivery row per recommendation and selected route. Telegram and selected-session delivery are independent consumers of a shared human-readable message model.

The outbox owns:

- stable idempotency key;
- route;
- payload version and digest;
- queued, sending, sent, retry-wait, and dead-letter states;
- attempt count;
- lease owner and expiry;
- next attempt time;
- provider receipt metadata; and
- last safe error category.

An enqueue event wakes the dispatcher. Timers exist only for a known future retry or lease expiry. There is no periodic Harvester completion poll.

### 6.6 Telegram adapter

The Telegram adapter owns Bot API transport, update checkpoints, pairing, chat authorization, message formatting limits, and Telegram task interaction. It receives the token through private configuration and uses the persisted paired user/chat identity as its destination.

### 6.7 Codex session adapter

The selected-session adapter uses Codex App Server conversation interfaces. The SDD should bind to documented operations for thread listing and search, persistent thread naming, thread resume, turn start, and turn completion notifications.

The adapter exposes the user-facing session name in onboarding and status. It stores the long session ID internally. It does not automatically pin the session.

### 6.8 Lifecycle and operations

The lifecycle component starts the runtime, applies approved migrations, resumes expired leases, starts selected delivery routes, and exposes bounded status and heartbeat checks. It must support restart without an interactive terminal remaining open.

## 7. Path, state, and secret model

### 7.1 Tracked paths

Every tracked reference is relative to the repository, plugin root, or skill root. Examples use placeholders such as <PLUGIN_ROOT> and <CODEX_HOME>. No tracked file contains a developer home directory, drive, hostname, bot token, user ID, chat ID, or thread ID.

### 7.2 Private runtime paths

Planned private layout:

    <CODEX_HOME>/.gorombo/
      .env
      gorombo-skill-harvester/
        state.sqlite3
        recommendations/
        logs/
        run/
        backups/

The exact retention of logs and backups remains subject to SDD. Temporary files must be created inside the owned runtime tree and atomically promoted.

### 7.3 Environment file

The real environment file is private and never stored in the skill. The public repository contains .env.example with names and explanations only. Telegram setup needs a token variable. User/chat identity is produced through pairing and stored as private application state rather than hardcoded source.

### 7.4 Permissions and redaction

On hosts that expose file permissions, the private root, environment file, and database must be owner-restricted. On every host, diagnostics must redact secret values and avoid printing complete provider requests or private task content.

## 8. Planned durable data model

The storage SDD should define migrations for at least these logical records:

- schema_meta: current schema and migration history;
- settings: non-secret product settings and selected delivery mode;
- completion_events: stable completion identity, evidence digest, state, and claim;
- assessments: versioned decision and decision metadata;
- recommendations: proposal ID, structured fields, Markdown path, content digest, and visibility state;
- delivery_outbox: per-route state, attempts, lease, schedule, and receipt;
- pairing_requests: expiring code digest and status;
- telegram_bindings: approved user/chat identity and binding state;
- telegram_updates: last processed update/checkpoint identity;
- session_routes: user-facing session name, internal session ID, and validation state;
- task_sessions: persistent Telegram-to-Codex task session mapping;
- task_runs: incoming task, execution state, result reference, and safe error;
- operational_events: bounded health, migration, and recovery events.

Secret values do not belong in normal settings or operational events.

## 9. Harvester decision contract

Every accepted completion reaches exactly one assessment outcome.

### 9.1 not-a-skill

Use when evidence does not justify reusable skill work. Store the decision and reason, acknowledge completion, and do not create a new-skill alert.

### 9.2 extend-existing

Use when reusable behavior belongs in an existing skill. Store the target skill and extension recommendation. The SDD must decide whether this outcome generates an alert and its exact content.

### 9.3 propose-new

Use when evidence justifies a new skill. Store and render a complete recommendation, then enqueue every selected route after owner visibility is durable.

A retry after crash reuses the original correlation and proposal identity. It does not run a second assessment when a durable assessment already exists.

## 10. Human-readable recommendation and alert

A propose-new recommendation must contain, at minimum:

- recommended skill name;
- concise purpose;
- why completed work supports the recommendation;
- when the skill should trigger;
- suggested procedure or workflow;
- evidence summary that is safe to display;
- proposal ID;
- saved recommendation location expressed relative to the runtime root; and
- next review action.

The alert may be shorter than the stored Markdown recommendation, but it must preserve the skill name, why, when, procedure summary, proposal ID, and saved location.

The alert must not expose raw private prompts, tokens, bot/user/chat/session IDs, complete internal event JSON, or a digest without explanatory words.

## 11. Delivery guarantees and recovery

Database state and recommendation files must be durable before delivery begins.

Internal enqueue is transactionally deduplicated by a stable key derived from recommendation identity, route, and payload version. Each enabled route progresses independently. Telegram failure cannot block selected-session delivery, and selected-session failure cannot erase a successful Telegram send.

Telegram Bot API does not provide a general application idempotency key for sendMessage. The design can therefore provide durable at-least-once delivery with stable internal deduplication, but a crash after Telegram accepted a message and before the local receipt commit may produce a duplicate. The SDD must make this ambiguous window explicit and test it.

On startup, the dispatcher:

1. recovers expired sending leases;
2. wakes immediately for queued work that is due;
3. schedules only the earliest known future retry or lease expiry; and
4. exposes dead-letter items for deliberate inspection and replay.

## 12. Telegram behavior

### 12.1 Pairing

The user creates the bot and stores its token in the private environment file. After the user sends the initial bot command, the running service creates a short-lived pairing code. Local approval records the approved user/chat identity. Codes are single-use and expire.

Unpaired messages receive a bounded response and cannot create tasks or change configuration.

### 12.2 Alerts

The adapter sends formatted, readable text from the common message model. It records Telegram message ID and safe response metadata on success. Provider errors are classified for retry, permanent failure, or configuration attention.

### 12.3 Tasks

Paired task messages are persisted before execution. The task bridge maps the paired chat to a persistent Codex task session, submits the request, and sends readable progress and a final result. Restart recovery must distinguish a task not started, in progress, completed but not replied, and replied.

The task SDD must define cancellation, attachments if any, command syntax, progress rate limits, execution authority, and approval boundaries.

## 13. Selected Codex session behavior

Onboarding presents or accepts the destination session by user-facing name and stores the resolved internal ID. The product confirms the persistent name through App Server rather than treating a transient title as identity.

For delivery:

- verify the stored thread;
- resume it through the documented interface;
- if idle, start an alert turn;
- if active, retain the outbox row and wake from turn completion;
- record the accepted turn ID as receipt metadata;
- keep the message in the outbox until required local receipt state is durable.

If the selected session is missing or unavailable, mark that route as needing attention. Do not silently select another session. In both mode, Telegram continues independently.

The injected turn should contain the useful recommendation and an instruction appropriate for the selected alert session. The SDD will define whether the receiving agent only records the alert or also performs a configured follow-up task.

## 14. Onboarding detail

Onboarding is a state machine, not a one-time setup script.

### 14.1 Inspect

- resolve package, skill, and Codex roots;
- inspect private state without exposing values;
- read schema version;
- identify selected delivery mode;
- validate required environment variable presence by name only;
- inspect Telegram binding and selected-session route;
- inspect lifecycle state.

### 14.2 Plan

Return exact missing steps and files that will be created or changed. Preserve already-valid state.

### 14.3 Apply

- create private directories;
- initialize or migrate the database transactionally;
- write non-secret settings;
- guide environment-file creation;
- perform Telegram pairing when selected;
- select and validate the Codex session when selected;
- install or enable the always-on lifecycle when approved by the onboarding spec.

### 14.4 Verify

- run database integrity and migration checks;
- send a test alert through each selected route;
- verify lifecycle and heartbeat;
- return READY or a specific non-secret failure state.

## 15. Operational commands expected

Exact command names are an SDD decision, but the product needs operations equivalent to:

- onboard;
- status;
- doctor;
- pair and approve-pairing-code;
- select-session;
- test-alert;
- start, stop, and restart;
- heartbeat or health;
- list recommendations;
- list pending and dead-letter deliveries;
- replay a selected delivery;
- migrate;
- uninstall runtime while preserving or explicitly removing private data.

Every diagnostic command must be safe to share after redaction.

## 16. Testing strategy

### 16.1 Unit tests

Cover path containment, root discovery, config validation, redaction, correlation identities, all three decisions, recommendation rendering, state transitions, retry scheduling, lease recovery, pairing code expiry, authorization, and session route resolution.

### 16.2 Database and migration tests

Create every supported prior schema, migrate it, verify the exact resulting schema and preserved records, and prove interrupted migration is recoverable.

### 16.3 Integration tests

Use fakes by default for Telegram and App Server. Cover pairing, alert send, task execution, selected-session delivery, both mode, missing credentials, missing session, provider errors, and restart.

### 16.4 Fault-injection tests

Terminate at every durable boundary:

- after completion persistence;
- after assessment commit;
- after recommendation file write;
- after recommendation visibility commit;
- after outbox enqueue;
- after delivery claim;
- after external acceptance but before receipt commit;
- after receipt commit but before completion acknowledgement.

Each test proves whether the next start retries, deduplicates, or finishes without loss.

### 16.5 Security tests

Search tracked artifacts and diagnostic output for secret-shaped values, absolute developer paths, user/chat/session IDs, raw private prompts, and unredacted provider errors.

### 16.6 End-to-end acceptance

With test credentials and isolated state, perform onboarding, pair Telegram, select a Codex session, create a proposed skill, receive human-readable alerts through the selected mode, submit a Telegram task, restart the runtime, and verify durable recovery.

## 17. Implementation phases and gates

### Phase 0 - accept the implementation plan

Deliverables are this plan, the confirmed-expectations register, expected-file inventory, decision register, acceptance matrix, and SDD roadmap.

Exit gate: the product is coherent on paper, confirmed requirements are separated from working choices, and unresolved choices are assigned to specifications.

### Phase 1 - write and approve the SDD set

Create the specifications listed in spec-roadmap.md under docs/specs/. Each specification must be detailed enough to implement and test without inventing behavior during coding.

Exit gate: every first-release requirement maps to an approved specification and acceptance case.

### Phase 2 - scaffold the public package

Create only the files authorized by the approved packaging specification: plugin metadata, skill package, runtime project, test harness, documentation, license, and continuous verification.

Exit gate: package and skill validators pass; no runtime feature is claimed yet.

### Phase 3 - implement paths, configuration, secrets, and onboarding

Implement Codex-root discovery, the private .gorombo layout, configuration parsing, secret redaction, database initialization, migration locking, onboarding, readiness, and status.

Exit gate: fresh and repeat onboarding pass with no credential disclosure and no hardcoded machine path.

### Phase 4 - implement the Harvester core

Implement completion intake, bounded evidence, deterministic correlation, the three decisions, recommendation rendering, owner-visible persistence, replay behavior, and completion acknowledgement.

Exit gate: unit, migration, replay, and fault-injection tests prove no recommendation is silently lost.

### Phase 5 - implement the delivery core

Implement message rendering, per-route outbox rows, wake signals, claims, leases, bounded retry, receipts, dead letters, replay, and independent route state.

Exit gate: crash tests at every durable boundary prove restart behavior, including the ambiguous external-send window.

### Phase 6 - implement Telegram alerts and pairing

Implement the bot update loop, local pairing-code approval, paired-identity authorization, human-readable alert delivery, provider error classification, and test delivery.

Exit gate: paired delivery works, unpaired identities are rejected, secrets are redacted, and restart preserves authorization and pending alerts.

### Phase 7 - implement Telegram tasks

Implement task creation, Codex task-session binding, progress reduction, final results, errors, restart recovery, and the approval behavior defined by SDD.

Exit gate: authorized tasks execute end to end and interrupted tasks reach a visible recovered state.

### Phase 8 - implement selected Codex session delivery

Implement App Server discovery, session lookup and selection, user-facing naming, internal-ID persistence, active-turn queueing, accepted-turn receipts, missing-session recovery, and test delivery.

Exit gate: session-only delivery works before restart, after restart, and while the selected session has an active turn.

### Phase 9 - implement both mode

Enable Telegram and selected-session routes together without coupling their state transitions.

Exit gate: one route may fail, retry, or dead-letter while the other succeeds, and status reports both results accurately.

### Phase 10 - implement lifecycle and operations

Implement install/start behavior, always-on operation, restart policy, heartbeat, health, diagnostics, backup, restore, update, and uninstall-data choices.

Exit gate: restart and host-reboot tests prove the runtime returns to service and drains recoverable work.

### Phase 11 - release readiness

Complete public README instructions, security review, secret/path scans, compatibility checks, clean-install verification, upgrade verification, package validation, and release artifact verification.

Exit gate: every acceptance-matrix row has recorded evidence and no unresolved release blocker remains.

## 18. Principal risks and planned mitigations

### 18.1 External send accepted before local receipt

Telegram and a Codex session may accept a message immediately before the process loses power. If the provider offers no idempotency key, restart cannot prove whether retry would duplicate the message.

Mitigation: persist stable delivery identity, expose the ambiguity, use provider receipts where available, bound retries, and never claim strict exactly-once delivery without provider evidence.

### 18.2 Recommendation exposes private evidence

A recommendation can accidentally copy prompts, credentials, paths, or unrelated work into an alert.

Mitigation: render from an explicit safe content model, store evidence digests separately, redact before persistence, cap every field, and test secret-shaped and private-path inputs.

### 18.3 Wrong Telegram identity controls tasks

A bot username or chat alone is not sufficient authorization.

Mitigation: require contact with the bot, generate a short-lived pairing code, approve it locally, bind the approved Telegram identity, and reject all other task senders before task persistence.

### 18.4 Selected session disappears or is busy

The saved session can be deleted, renamed, inaccessible, or running an active turn.

Mitigation: store the internal ID, retain the display name for the user, verify existence before delivery, queue while busy, wake on completion, and provide a reselection command when missing.

### 18.5 Process restart creates loss or duplicate work

A crash between state transitions can strand claims or repeat assessment and delivery.

Mitigation: define every transition in SDD, commit durable state before acknowledgement, use leases and stable identities, recover expired claims at startup, and fault-test every boundary.

### 18.6 Runtime state conflicts across installations

Multiple copies can target one .gorombo database or incompatible schema.

Mitigation: include ownership metadata, schema version, migration lock, runtime-instance lease, compatibility check, backup before migration, and refusal on unsafe downgrade.

### 18.7 Public package contains a machine-specific path or secret

Developer paths, user IDs, bot tokens, session IDs, or generated state can enter Git.

Mitigation: keep runtime state outside the repository, publish only placeholder variable names, ignore common secret files, and require path and secret scans before release.

## 19. Definition of ready for code

Coding may begin only when:

- the implementation plan is accepted;
- the required specifications exist under docs/specs/ and are approved;
- each first-release requirement has an owning specification;
- exact schemas and state transitions are defined;
- command and API contracts are defined;
- security and redaction rules are testable;
- unresolved choices that affect implementation are closed or explicitly deferred;
- every planned component has acceptance cases; and
- the expected-file inventory matches the approved specifications.

## 20. Definition of product done

The first working implementation is done when:

- fresh onboarding succeeds for Telegram, selected session, and both;
- repeat onboarding is idempotent;
- all three Harvester decisions are durable and replay-safe;
- a proposed skill produces a readable stored recommendation;
- the same readable recommendation reaches every selected route;
- Telegram accepts tasks only from the paired identity;
- selected-session delivery is findable by its user-facing name and survives restart;
- each route has independent durable status, retry, dead-letter, and replay behavior;
- always-on operation, restart recovery, health, and heartbeat are verified;
- no tracked artifact or diagnostic output contains a secret or machine-specific path;
- migration, failure, and recovery tests pass;
- public installation and operation documentation is accurate; and
- every acceptance-matrix row has objective evidence.

## 21. Handoff to spec-driven development

The next phase creates docs/specs/ from spec-roadmap.md. The specifications expand this plan; they do not silently change confirmed requirements.

For each specification:

1. copy the confirmed requirements and acceptance IDs it owns;
2. define exact behavior, data, states, errors, security, and observability;
3. describe implementation steps in dependency order;
4. define unit, integration, migration, fault, and acceptance tests;
5. record unresolved decisions rather than guessing;
6. review cross-spec interfaces for contradictions; and
7. approve the specification before creating the code it governs.

When a later discovery changes a confirmed product decision, update the decision register, affected expectations, acceptance matrix, implementation plan, and specifications together before coding continues.
