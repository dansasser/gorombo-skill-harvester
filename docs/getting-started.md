# Getting Started

## Requirements

- Node.js 22.13.0 or newer.
- An authenticated stable Codex CLI 0.147.0 or newer.
- A Telegram bot token and Telegram user ID only for the Telegram route.

Run Gorombo Skill Harvester as the same operating-system user that owns the Codex installation and authentication state.

## Install from source

From the repository root:

```sh
npm install
npm run verify
npm install --global .
gorombo-skill-harvester preflight --json
```

The global install exposes the `gorombo-skill-harvester` command. Connect the repository through the local Codex plugin-development flow so Codex can load the included skill and completion hook. Public npm and Codex plugin-directory distribution are not live during the pre-release.

Preflight verifies the required Node version, discovers a compatible stable Codex CLI, checks Codex authentication, and confirms that Codex App Server is available. Its output excludes launcher paths, authentication details, and raw probe output.

## Choose a route

Gorombo Skill Harvester supports one route mode per private state:

- `telegram`: deliver alerts through Telegram and accept authorized Telegram text tasks.
- `session`: deliver alerts to one selected Codex task.
- `both`: enable both routes with independent delivery state and receipts.

Choose the mode during onboarding:

```sh
gorombo-skill-harvester onboard --route telegram
gorombo-skill-harvester onboard --route session
gorombo-skill-harvester onboard --route both
```

The first successful onboarding fixes the route mode for that private state. Rerunning onboarding with a different mode is rejected.

## Configure Telegram

Skip this section when using only the session route.

Create `<CODEX_HOME>/.gorombo/.env` using the variable names in [.env.example](../.env.example). Store real values only in that private file.

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_ALLOWED_USER_IDS=replace-with-your-telegram-user-id
GOROMBO_SKILL_HARVESTER_TASK_CWD=replace-with-the-task-working-directory
GOROMBO_SKILL_HARVESTER_TASK_SANDBOX=read-only
GOROMBO_SKILL_HARVESTER_TASK_MODEL=replace-with-the-model-name
```

The task working directory is runtime configuration supplied by the operator. The model field is optional. See [Configuration](configuration.md) for field rules and permissions.

Run the selected onboarding command again after the private environment file is ready.

If replacing an existing TeleCodex installation, follow [Migration](migration.md) before starting the Gorombo Skill Harvester runtime.

## Start the temporary runtime

```sh
gorombo-skill-harvester serve
```

Leave this process running while completing route setup. Run the remaining local commands from another shell.

## Pair and test Telegram

1. Send `/start` to the bot.
2. Copy the six-character pairing code returned by the bot.
3. Approve the code locally:

   ```sh
   gorombo-skill-harvester pair ABC123
   ```

4. Confirm the approval message arrived in Telegram.
5. Test the route:

   ```sh
   gorombo-skill-harvester route test telegram
   ```

Only identities listed in `TELEGRAM_ALLOWED_USER_IDS` can create pairing requests or submit tasks. The bot, user, and private chat binding is stored in private state.

## Select and test a Codex task

List visible tasks and select one by its exact name:

```sh
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Gorombo Skill Harvester"
```

Or create a named task from the working directory that should own it:

```sh
gorombo-skill-harvester session create "Gorombo Skill Harvester"
```

Test delivery:

```sh
gorombo-skill-harvester route test session
```

The visible name is the user-facing locator. Gorombo Skill Harvester stores the internal task ID only in private state and refuses missing, renamed, inaccessible, or duplicate-name destinations instead of silently choosing another task.

Gorombo Skill Harvester does not pin the selected task. Pin it in Codex if desired.

## Confirm readiness

For `both` mode, finish and test both routes. Then run:

```sh
gorombo-skill-harvester status --json
```

`READY` means storage and every selected route are ready.

## Install the always-on service

Stop the temporary runtime and install the current user's service:

```sh
gorombo-skill-harvester shutdown
gorombo-skill-harvester service install
gorombo-skill-harvester service status --json
```

The generated service definition uses paths discovered on the host and restart-on-failure behavior. No terminal needs to remain open after installation.

## Confirm the working flow

Complete a Codex goal using `update_goal` with status `complete`. A `propose-new` decision should create one Markdown recommendation and deliver a readable alert to every selected route.

For Telegram, send one normal text task and confirm the bot returns its task ID and final result.
