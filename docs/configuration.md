# Configuration

## Runtime root

Gorombo Skill Harvester resolves the Codex root from `CODEX_HOME`. When `CODEX_HOME` is unset, it uses the current user's standard Codex directory.

Private Gorombo Skill Harvester state is stored beneath that discovered root:

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

The repository and installed skill contain only relative project paths and placeholders. Runtime-supplied paths belong in private configuration.

## Environment file

The real environment file is:

```text
<CODEX_HOME>/.gorombo/.env
```

Do not put it in the repository, plugin directory, or skill directory. Restrict access to the current user; mode `0600` is appropriate on POSIX hosts.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram route | Bot token created through Telegram |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram route | Comma-separated Telegram users allowed to pair and submit tasks |
| `GOROMBO_SKILL_HARVESTER_TASK_CWD` | Telegram route | Working directory used for Telegram text tasks |
| `GOROMBO_SKILL_HARVESTER_TASK_SANDBOX` | Telegram route | `read-only`, `workspace-write`, or `danger-full-access` |
| `GOROMBO_SKILL_HARVESTER_TASK_MODEL` | No | Optional Codex model for Telegram tasks |

Do not paste real values into prompts, command arguments, issues, logs, screenshots, fixtures, or documentation.

## Route configuration

The route mode is one of `telegram`, `session`, or `both`. It is selected during onboarding and stored in the private `config.json`.

Gorombo Skill Harvester creates product directories, configuration, and the SQLite database during onboarding. It never creates the real `.env`.

### Telegram binding

Telegram pairing begins only after an allowed user contacts the running bot. The bot returns a short-lived code, and local approval creates one active private binding for the bot, user, and private chat.

Pairing data is application state, not an environment variable. Do not copy it into public configuration or documentation.

### Selected Codex task

The user selects or creates a task by its exact visible name. Gorombo Skill Harvester stores the internal task ID privately and revalidates the name-to-ID relationship before delivery.

Duplicate names, renaming, deletion, access loss, or an ID mismatch block the route until the operator explicitly selects it again.

## Task authority

The default sandbox for Telegram tasks is `read-only`.

- `read-only`: the task can inspect but not modify the working directory.
- `workspace-write`: the task can modify the configured workspace.
- `danger-full-access`: the task receives broad host file authority.

Choose broader access only when the operator intends it. Gorombo Skill Harvester rechecks the allowlist, active pairing, route readiness, working directory, and sandbox immediately before launch.

## Portability

Reusable files must not contain a machine-specific drive, home directory, hostname, installation location, bot token, user identity, chat identity, internal Codex task ID, or other private key. Runtime absolute paths are valid only when supplied through the environment, current working directory, explicit runtime arguments, or discovery on the host.
