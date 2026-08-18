# Gorombo Skill Harvester

[![Version](https://img.shields.io/badge/version-0.1.2-blue)](package.json)
[![Status](https://img.shields.io/badge/status-pre--release-orange)](#release-status)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org/)
[![Codex](https://img.shields.io/badge/Codex_CLI-%3E%3D0.147-111827)](https://developers.openai.com/codex/cli/)
[![Gorombo](https://img.shields.io/badge/by-Gorombo-black)](https://gorombo.com/)
[![GitHub](https://img.shields.io/badge/GitHub-dansasser%2Fgorombo--skill--harvester-181717?logo=github)](https://github.com/dansasser/gorombo-skill-harvester)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Gorombo Skill Harvester turns completed Codex work into durable, human-readable skill recommendations. It can deliver each recommendation through Telegram, to one selected Codex task, or to both. The Telegram route can also accept authorized text tasks and return their results.

> **Pre-release:** Gorombo Skill Harvester can be verified and installed from source. Public npm and Codex plugin-directory distribution are not live yet.

## What it does

- Detects successful Codex goal completions through the included plugin hook.
- Assesses completed work for reusable skill opportunities.
- Saves each proposed skill as a readable Markdown recommendation.
- Delivers useful alerts with the skill name, purpose, reason, use cases, suggested procedure, and next action.
- Supports Telegram alerts and tasks, a selected Codex task destination, or both routes together.
- Persists recommendations, delivery work, attempts, and receipts for restart recovery.
- Runs as an always-on user service after onboarding; no terminal needs to remain open.

The completion path is event-driven:

```text
Codex goal completes
-> completion hook commits a private handoff
-> Gorombo Skill Harvester assesses the completed work
-> a proposed skill is saved as Markdown
-> each selected route receives a readable alert
```

## Requirements

- Node.js 22.13.0 or newer.
- An authenticated stable Codex CLI 0.147.0 or newer, available to the user running Gorombo Skill Harvester.
- A Telegram bot token and Telegram user ID only when the Telegram route is selected.

## Quick start

### 1. Install from a source checkout

```sh
npm install
npm run verify
npm install --global .
gorombo-skill-harvester preflight --json
```

The global install exposes the `gorombo-skill-harvester` command. During pre-release development, connect this repository as a local Codex plugin so Codex can load its skill and completion hook. See the official [Codex plugin documentation](https://developers.openai.com/codex/plugins/).

If upgrading from the previous product identity, stop and uninstall its user service first, then preserve the existing state with:

```sh
gorombo-skill-harvester migrate --confirm
```

The migration moves the existing private state directory as one atomic operation. It does not rewrite `<CODEX_HOME>/.gorombo/.env`; previous `HARVESTER_V2_TASK_*` names remain accepted as compatibility aliases, while new setup uses only `GOROMBO_SKILL_HARVESTER_TASK_*`.

### 2. Choose a route

| Route | What it provides | Setup |
| --- | --- | --- |
| `telegram` | Alerts and authorized Telegram text tasks | Add the private Telegram settings, pair the bot, and test the route |
| `session` | Alerts in one named Codex task | Select or create the task, then test the route |
| `both` | Independent delivery to Telegram and a Codex task | Complete and test both route setups |

For Telegram, create the private environment file at `<CODEX_HOME>/.gorombo/.env` using [.env.example](.env.example). Keep real values out of this repository.

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_ALLOWED_USER_IDS=replace-with-your-telegram-user-id
GOROMBO_SKILL_HARVESTER_TASK_CWD=replace-with-the-task-working-directory
GOROMBO_SKILL_HARVESTER_TASK_SANDBOX=read-only
GOROMBO_SKILL_HARVESTER_TASK_MODEL=replace-with-the-model-name
```

`GOROMBO_SKILL_HARVESTER_TASK_MODEL` is optional. The task sandbox can be `read-only`, `workspace-write`, or `danger-full-access`; `read-only` is the default.

### 3. Onboard and test

Choose one route mode:

```sh
gorombo-skill-harvester onboard --route telegram
gorombo-skill-harvester onboard --route session
gorombo-skill-harvester onboard --route both
```

Start the temporary runtime while completing route setup:

```sh
gorombo-skill-harvester serve
```

For Telegram, send `/start` to the bot, then approve the six-character code locally and test delivery:

```sh
gorombo-skill-harvester pair ABC123
gorombo-skill-harvester route test telegram
```

For a selected Codex task, choose an existing visible name or create a new one from the desired working directory:

```sh
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Gorombo Skill Harvester"
# Or:
gorombo-skill-harvester session create "Gorombo Skill Harvester"
gorombo-skill-harvester route test session
```

Confirm readiness, stop the temporary runtime, and install the user service:

```sh
gorombo-skill-harvester status --json
gorombo-skill-harvester shutdown
gorombo-skill-harvester service install
gorombo-skill-harvester service status --json
```

See [Getting started](docs/getting-started.md) for the complete route-specific flow.

## Using Gorombo Skill Harvester

After the service is ready, successful Codex goal completions are assessed automatically. A `propose-new` decision creates a recommendation beneath:

```text
<CODEX_HOME>/.gorombo/gorombo-skill-harvester/recommendations/
```

Telegram commands:

- Send normal text to run an authorized Codex task.
- Send `/status` for safe route and task state.
- Send `/cancel` to cancel queued work or request cancellation of the running task.
- Send `/help` for the available commands.

Useful local commands:

```sh
gorombo-skill-harvester doctor --json
gorombo-skill-harvester status --json
gorombo-skill-harvester service status --json
gorombo-skill-harvester route pause telegram
gorombo-skill-harvester route resume telegram
gorombo-skill-harvester route pause session
gorombo-skill-harvester route resume session
```

## File structure

Public repository layout:

```text
.codex-plugin/                 Codex plugin manifest
hooks/                         Completion hook
skills/gorombo-skill-harvester/           Agent-facing skill and references
src/                           CLI and runtime implementation
migrations/                    SQLite schema migrations
docs/                          Public guides, plans, and specifications
test/                          Deterministic test suite
```

Private runtime layout:

```text
<CODEX_HOME>/.gorombo/
|-- .env
+-- gorombo-skill-harvester/
    |-- config.json
    |-- state.sqlite3
    |-- completion-spool/
    |-- recommendations/
    |-- run/
    |-- logs/
    |-- backups/
    +-- recovery/
```

The repository contains no real `.env`, credential, pairing record, private identity, or machine-specific runtime path.

## Documentation

- [Documentation hub](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Operations and troubleshooting](docs/operations.md)
- [Migration](docs/migration.md)
- [Security Policy](SECURITY.md)
- [Support](SUPPORT.md)

## Development

```sh
npm run check
npm test
npm run verify
npm pack --dry-run --json
```

`npm run verify` checks source syntax, validates the skill and package inventory, scans both the GitHub repository candidates and packed public files, runs the deterministic test suite, and verifies an isolated packed installation.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Release status

Version 0.1.2 is the current pre-release source baseline. Public npm publication and Codex plugin-directory submission remain pending.

## License

Gorombo Skill Harvester is released under the [MIT License](LICENSE).
