# Migration

## Upgrade from the previous product identity

Stop and uninstall the previous user service before migrating. Do not run the previous and current Telegram pollers together.

```sh
gorombo-skill-harvester migrate --confirm
```

The command moves `<CODEX_HOME>/.gorombo/harvester-v2` to `<CODEX_HOME>/.gorombo/gorombo-skill-harvester` with a same-parent atomic rename. It refuses to merge roots, refuses an existing or uncertain runtime lock, validates SQLite integrity, and verifies recommendation-file digests after the move. Existing database rows, pairing state, selected task bindings, recommendations, queues, and receipts remain unchanged.

The shared `<CODEX_HOME>/.gorombo/.env` file is not rewritten. Existing `HARVESTER_V2_TASK_CWD`, `HARVESTER_V2_TASK_SANDBOX`, and `HARVESTER_V2_TASK_MODEL` values remain accepted. New names are `GOROMBO_SKILL_HARVESTER_TASK_CWD`, `GOROMBO_SKILL_HARVESTER_TASK_SANDBOX`, and `GOROMBO_SKILL_HARVESTER_TASK_MODEL`. If an old and new name are both present with different values, startup fails instead of choosing one silently.

Pending six-character pairing codes issued before migration remain approvable. Existing selected Codex tasks keep their stored names and IDs; only newly created default tasks use `Gorombo Skill Harvester`.

## Migration from TeleCodex

Gorombo Skill Harvester can import one approved private Telegram binding and its private environment from a supported TeleCodex installation. This lets an existing bot continue without generating a new pairing code.

## Before importing

1. Install and verify Gorombo Skill Harvester.
2. Identify the legacy TeleCodex state root, environment file, and desired task working directory on the host.
3. Stop the legacy Telegram poller so only one process receives updates for the bot.
4. Keep the legacy files unchanged until the new route test succeeds.

The import command accepts runtime-supplied absolute paths. Those paths belong in the local command invocation and are never stored in reusable public files.

## Import

Run before starting the Gorombo Skill Harvester runtime:

```sh
gorombo-skill-harvester import telecodex \
  --legacy-root "ABSOLUTE_LEGACY_STATE_PATH" \
  --legacy-env "ABSOLUTE_LEGACY_ENV_PATH" \
  --task-cwd "ABSOLUTE_TASK_WORKING_DIRECTORY"
```

The import:

- reads the legacy state and private environment without modifying them;
- verifies the Telegram bot identity;
- maps the allowlist, task working directory, sandbox, and optional model into the private Gorombo Skill Harvester environment;
- imports exactly one approved private binding;
- creates no Telegram update poller and sends no message during import;
- fails without replacing a conflicting Gorombo Skill Harvester binding;
- is idempotent when repeated with the same source state.

The command emits bounded status data and does not print token values or private identities.

## Verify

Start Gorombo Skill Harvester and test the imported route:

```sh
gorombo-skill-harvester serve
gorombo-skill-harvester route test telegram
gorombo-skill-harvester status --json
```

After the route is `READY`, stop the temporary runtime and install the user service as described in [Getting started](getting-started.md).

## Rollback boundary

The import leaves the legacy files unchanged. If verification fails, stop Gorombo Skill Harvester before investigating or restarting the legacy runtime. Never run both Telegram pollers at the same time.

Do not copy credentials, user identities, chat identities, pairing records, or local machine paths into issues or documentation while troubleshooting.
