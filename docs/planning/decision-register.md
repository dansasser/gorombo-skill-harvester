# Decision register

Status values:

- Confirmed: already chosen for this project.
- Implemented baseline: present in source, tests, and the applicable SDD; public-release approval can still remain open.
- Open gate: must be decided before public publication or before the affected behavior is claimed as approved.
- Later: deliberately outside the first working implementation.

## Confirmed decisions

### Product

- Status: Confirmed
- Decision: Build a public Gorombo Skill Harvester skill that combines skill harvesting with alert delivery.
- Reason: The recommendation, durable record, and notification belong to one coherent product flow.

### Initial alert service

- Status: Confirmed
- Decision: Build the first working alert implementation with Telegram.
- Reason: Telegram is the current working route. Other messaging services can be added after Telegram works.

### Delivery choices

- Status: Confirmed
- Decision: A user can choose Telegram, a selected Codex session, or both.
- Reason: Telegram provides an immediate external alert. A selected Codex session provides a durable, searchable in-Codex destination.

### Selected Codex session identity

- Status: Confirmed
- Decision: The user works with the destination session by its user-facing name. The implementation stores the long session ID internally.
- Reason: A name is practical to search for, open, and pin. The long ID is implementation state, not the normal user interface.

### Pinning

- Status: Confirmed
- Decision: The product does not automatically pin the selected session.
- Reason: The user can pin it from desktop or mobile if desired.

### Alert content

- Status: Confirmed
- Decision: Alerts contain useful words, including the recommended skill and the reason for the recommendation. A raw internal JSON object or digest-only message is not an acceptable user alert.
- Reason: The alert must let the user understand and act without opening internal storage first.

### Harvester trigger

- Status: Confirmed
- Decision: The harvester directly enqueues the alert after the recommendation is durably written and ready for the owner. It does not poll its own database to discover completed work.
- Reason: Direct event handoff is immediate and avoids unnecessary periodic work.

### Telegram tasks

- Status: Confirmed
- Decision: The Telegram route supports task requests as well as alerts.
- Reason: The bot is both a notification route and a way to perform tasks.

### Telegram routing

- Status: Confirmed
- Decision: The first implementation uses the paired Telegram user and chat identity. It does not require Telegram topic routing.
- Reason: Pairing is based on the bot token and approved user/chat identity.

### Runtime root

- Status: Confirmed
- Decision: Resolve the Codex root at runtime and place Gorombo-owned mutable data beneath <CODEX_HOME>/.gorombo/.
- Reason: The public package cannot contain a machine-specific path, while the user needs one predictable private state root.

### Relative paths

- Status: Confirmed
- Decision: Project-owned paths are relative to the skill or project root. Runtime-owned paths are relative to the discovered Codex root. No reusable artifact hardcodes a machine path.
- Reason: The package must be portable while retaining a stable runtime location.

### Secrets

- Status: Confirmed
- Decision: No key or real secret is committed. The private environment file is <CODEX_HOME>/.gorombo/.env. The repository contains only a documented example.
- Reason: A public skill must keep credentials outside its tracked files.

### Onboarding

- Status: Confirmed
- Decision: First use checks readiness, creates the required private directories and database when needed, gathers the chosen delivery configuration, and verifies the selected route or routes.
- Reason: Installation alone is not enough to establish tokens, pairing, storage, or a selected session.

### Planning before code

- Status: Completed historical gate
- Decision: Accept the implementation plan, then write detailed SDD documents in docs/specs/, and create code only from approved specs.
- Reason: The product should work hypothetically on paper before implementation starts.
- Current state: The plan and SDD sequence were completed and the implementation now exists. Current behavior is governed by the applicable SDD and verified source.

## Implemented baselines

### Packaging

- Status: Implemented baseline
- Decision: Package the product as a Codex plugin containing the Gorombo Skill Harvester skill, hook, runtime, tests, and documentation.
- Evidence: .codex-plugin/plugin.json, package.json, the packed-install test, and SDD 011.

### Implementation language

- Status: Implemented baseline
- Decision: Use ESM JavaScript on Node.js 22.13.0 or newer.
- Evidence: package.json, src/, test/, and the packed-artifact verifier.

### Durable store

- Status: Implemented baseline
- Decision: Use SQLite for structured state and Markdown files for human-readable skill recommendations.
- Evidence: migrations/001-initial.sql, src/storage.js, src/harvester.js, and SDDs 004-006.

### Telegram update transport

- Status: Implemented baseline
- Decision: Use bounded Telegram Bot API long polling under the always-on runtime. Harvester completion delivery remains direct and event-driven rather than periodically polled.
- Evidence: src/telegram-update-loop.js, src/runtime.js, and SDD 007.

### Codex session integration

- Status: Implemented baseline
- Decision: Use Codex App Server thread listing, naming, turn starting, and matching completion notifications for the selected named task.
- Evidence: src/app-server.js, src/session-route.js, and SDD 009.

### Selected-session setup

- Status: Implemented baseline
- Decision: List visible task names, select exactly one existing name or create one named task, verify exact-name readback, and require a successful route test before READY.
- Evidence: src/session-route.js, src/cli.js, and SDD 009.

### Recommendation schema

- Status: Implemented baseline
- Decision: Store and render the bounded version 1 recommendation fields defined by SDD 005.
- Evidence: src/content.js, src/assessment.js, and deterministic content tests.

## Open gates

### Public identity

- Status: Open gate
- Needed before: Packaging and release specs.
- Question: Confirm or change the implemented public identity before publishing.
- Current baseline: Gorombo Skill Harvester, repository slug gorombo-skill-harvester, npm package @gorombo/gorombo-skill-harvester, version 0.1.0.

### License

- Status: Open gate
- Needed before: Public release.
- Question: Confirm or change the current MIT license before publishing.

### Git remote

- Status: Open gate
- Needed before: Publishing.
- Question: Where will the public remote repository live?
- Boundary: Local planning does not create or assume a remote.

### Retention

- Status: Open gate
- Needed before: Storage and operations specs.
- Question: How long should recommendations, task records, delivery records, and operational logs be retained by default?

### Retry limits

- Status: Open gate
- Needed before: Outbox and recovery spec.
- Question: What retry schedule and dead-letter threshold should be the public default?

### Task authority

- Status: Open gate
- Needed before: Telegram task execution spec.
- Question: Which tasks require an explicit approval step before an agent acts?
- Boundary: The plan does not claim that a model policy automatically provides a Telegram approval gate.

## Later decisions

- Status: Later
- Decision area: Discord, WhatsApp, and other messaging services.
- Boundary: Design route interfaces so another service can be specified later, but do not implement those services before the Telegram implementation works.
