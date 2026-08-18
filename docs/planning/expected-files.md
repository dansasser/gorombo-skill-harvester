# Gorombo Skill Harvester files and data layout

## 1. Path rule

Repository-owned paths are relative to the repository or skill root as appropriate. Runtime absolute paths are resolved from CODEX_HOME, the current user, an explicit runtime argument, or a service manager. Reusable files do not hardcode a machine path, bot token, user ID, chat ID, Codex task ID, or other key.

## 2. Implemented repository tree

~~~text
.
|-- .codex-plugin/
|   +-- plugin.json
|-- skills/
|   +-- gorombo-skill-harvester/
|       |-- SKILL.md
|       |-- agents/
|       |   +-- openai.yaml
|       +-- references/
|           |-- onboarding.md
|           +-- operations.md
|-- hooks/
|   |-- hooks.json
|   +-- completion-hook.mjs
|-- migrations/
|   +-- 001-initial.sql
|-- scripts/
|   |-- validate-skill.mjs
|   |-- validate-package.mjs
|   |-- scan-public.mjs
|   +-- verify-release.mjs
|-- src/
|   |-- app-server.js
|   |-- assessment-runner.js
|   |-- assessment-worker.js
|   |-- assessment.js
|   |-- catalog.js
|   |-- cli.js
|   |-- codex-launcher.js
|   |-- codex-process.js
|   |-- completion-hook.js
|   |-- completion-spool.js
|   |-- config.js
|   |-- constants.js
|   |-- content.js
|   |-- control.js
|   |-- harvester.js
|   |-- ids.js
|   |-- onboarding.js
|   |-- outbox.js
|   |-- pairing.js
|   |-- paths.js
|   |-- preflight.js
|   |-- readiness.js
|   |-- recovery.js
|   |-- runtime-lock.js
|   |-- runtime.js
|   |-- service.js
|   |-- session-route.js
|   |-- storage.js
|   |-- task-result-dispatcher.js
|   |-- task-worker.js
|   |-- tasks.js
|   |-- telegram-identity.js
|   |-- telegram-inbound.js
|   |-- telegram-replies.js
|   |-- telegram-send-gate.js
|   |-- telegram-update-loop.js
|   +-- telegram.js
|-- test/
|   |-- app-server-session.test.js
|   |-- assessment-worker.test.js
|   |-- catalog.test.js
|   |-- config.test.js
|   |-- completion-spool.test.js
|   |-- content.test.js
|   |-- harvester.test.js
|   |-- onboarding-readiness.test.js
|   |-- outbox.test.js
|   |-- package-release.test.js
|   |-- pairing-telegram.test.js
|   |-- paths.test.js
|   |-- runtime-cli.test.js
|   |-- runtime-control-hook.test.js
|   |-- service.test.js
|   |-- storage.test.js
|   |-- task-runtime.test.js
|   |-- tasks-codex.test.js
|   +-- telegram-runtime.test.js
|-- docs/
|   |-- planning/
|   +-- specs/
|-- .env.example
|-- .gitignore
|-- LICENSE
|-- README.md
|-- SECURITY.md
|-- package.json
+-- package-lock.json
~~~

The Git repository contains package-lock.json for reproducible development. npm intentionally omits package-lock.json from the public tarball. The public tarball includes test/ so its installed release verifier runs the complete deterministic suite.

## 3. Public package responsibilities

- .codex-plugin/plugin.json: plugin identity and skill registration.
- skills/gorombo-skill-harvester/: skill instructions, metadata, onboarding, and operations.
- hooks/: successful goal-completion intake using the documented plugin root variable.
- migrations/: immutable SQLite schema and identity.
- src/: runtime, storage, Harvester, delivery adapters, Telegram, selected-task routing, local control, service lifecycle, and CLI.
- scripts/: syntax, skill-reference, package-inventory, path, and credential checks.
- test/: deterministic product and packed-artifact verification shipped with the public package.
- docs/: design history and SDD contracts.
- .env.example: names and placeholders only.
- README.md and SECURITY.md: public install, operation, limitations, and reporting boundary.

## 4. Repository-only files

package-lock.json is repository-only. The empty or generated outputs/ location is not in the npm package. Git metadata, node_modules, temporary tarballs, and broker staging residue are not public package files.

## 5. Private runtime layout

Nothing in this layout is committed or packed:

~~~text
<CODEX_HOME>/.gorombo/
|-- .env
+-- gorombo-skill-harvester/
    |-- config.json
    |-- state.sqlite3
    |-- completion-spool/
    |-- recommendations/
    |   +-- <recommendation-id>.md
    |-- run/
    |   |-- runtime.lock
    |   |-- wake endpoint
    |   +-- heartbeat.json
    |-- logs/
    |-- backups/
    +-- recovery/
~~~

- .env contains Telegram and task-execution values when Telegram is selected.
- config.json contains non-secret route choices and secret variable names.
- state.sqlite3 contains durable completion, recommendation, pairing, task, outbox, attempt, receipt, route, and migration state.
- completion-spool/ contains private, bounded handoff records until SQLite acceptance commits.
- recommendations/ contains owner-visible Markdown recommendations.
- run/ contains ephemeral ownership, local control, wake, and heartbeat artifacts.
- logs/, backups/, and recovery/ are reserved private product directories. Version 0.1.0 exposes no public backup, restore, or private-delete command.

## 6. Creation boundary

Installation creates no private state. status --json remains read-only when the state root is absent. onboard is the first command allowed to create the product directories, config, and database. It never creates the real .env.

Service installation occurs only after every selected route is READY. Service uninstall removes the generated service definition and preserves all private state.
