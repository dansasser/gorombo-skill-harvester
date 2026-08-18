# Onboarding Gorombo Skill Harvester

## 1. Check the host

From the plugin root, run:

~~~sh
node src/cli.js preflight --json
node src/cli.js status --json
~~~

preflight must pass. It requires Node 22.13 or newer and an authenticated stable Codex CLI 0.147.0 or newer. It uses bounded read-only probes for version, `codex login status`, and `codex app-server --help`; the App Server probe confirms command availability rather than a full protocol handshake.

The JSON report contains safe categories and versions only. It does not expose the resolved launcher path, authentication mode, or probe stdout/stderr. A fresh installation should report NEEDS_ONBOARDING without creating private state.

## 2. Choose delivery

Choose telegram, session, or both:

~~~sh
gorombo-skill-harvester onboard --route telegram
gorombo-skill-harvester onboard --route session
gorombo-skill-harvester onboard --route both
~~~

The first onboard command fixes the route mode for this private state. A later route-mode change requires a dedicated configuration operation; rerunning onboard with a different mode is rejected.

## 3. Configure Telegram when selected

Create the real file at <CODEX_HOME>/.gorombo/.env. Copy the field names from .env.example and replace the placeholders privately.

Required fields:

- TELEGRAM_BOT_TOKEN: token from BotFather.
- TELEGRAM_ALLOWED_USER_IDS: one or more comma-separated Telegram user IDs.
- GOROMBO_SKILL_HARVESTER_TASK_CWD: absolute working directory used for Telegram tasks.
- GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: read-only, workspace-write, or danger-full-access.
- GOROMBO_SKILL_HARVESTER_TASK_MODEL: optional model name used for Telegram tasks.

Do not put the file in the plugin or skill directory. Do not provide the token through chat or a command argument.

Run gorombo-skill-harvester onboard --route telegram or both again after the file is ready. Output identifies variable names and relative private locations, never values.

### Carry over an installed TeleCodex binding

Before starting Gorombo Skill Harvester, run:

~~~sh
gorombo-skill-harvester import telecodex --legacy-root "PATH_TO_TELECODEX_STATE" --legacy-env "PATH_TO_TELECODEX_ENV" --task-cwd "TASK_WORKING_DIRECTORY"
~~~

Replace each placeholder with the runtime path discovered on the host. The import reads the legacy files without changing them, verifies the existing bot identity, maps the allowed users, working directory, sandbox, and optional model into the private Gorombo Skill Harvester environment, and imports exactly one approved private binding. It performs no Telegram polling or sending. Stop the old poller before starting Gorombo Skill Harvester; after import, skip the pairing-code steps and run the Telegram route test.

## 4. Start the temporary runtime

~~~sh
gorombo-skill-harvester serve
~~~

Keep this runtime active only while finishing route setup. Run the following local commands from a second shell.

## 5. Pair and test Telegram

1. Send /start to the bot.
2. Copy the six-character code it returns.
3. Approve locally with gorombo-skill-harvester pair ABC123.
4. Wait for the confirmation in Telegram.
5. Run gorombo-skill-harvester route test telegram.

The allowlist is checked before the bot creates a pairing request.

## 6. Select and test a Codex task

~~~sh
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Gorombo Skill Harvester"
~~~

Or create a named task from the desired working directory:

~~~sh
gorombo-skill-harvester session create "Gorombo Skill Harvester"
~~~

The name must resolve to exactly one accessible Codex task. Gorombo Skill Harvester keeps the internal ID private and revalidates the name-to-ID binding before delivery.

Run:

~~~sh
gorombo-skill-harvester route test session
~~~

For both mode, complete and test both routes.

## 7. Confirm readiness and install the service

~~~sh
gorombo-skill-harvester status --json
~~~

When it reports READY, stop the temporary runtime:

~~~sh
gorombo-skill-harvester shutdown
~~~

Install the always-on user service:

~~~sh
gorombo-skill-harvester service install
gorombo-skill-harvester service status --json
~~~

No terminal needs to remain open after the service is installed.

## 8. Confirm the working flow

Complete a Codex goal with update_goal status complete. A propose-new decision should create one Markdown recommendation and deliver a human-readable alert to every selected route.

For Telegram, also send one normal text task and confirm that the bot returns its task ID and final result.
