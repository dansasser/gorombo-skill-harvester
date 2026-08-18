# Operations and Troubleshooting

## Status and diagnostics

```sh
gorombo-skill-harvester preflight --json
gorombo-skill-harvester doctor --json
gorombo-skill-harvester status --json
gorombo-skill-harvester service status --json
```

Status is bounded and redacted. `READY` means every selected route is ready. `DEGRADED` means a selected component needs attention. `RECOVERY_REQUIRED` pauses unsafe work.

## Runtime and service lifecycle

Foreground diagnostics:

```sh
gorombo-skill-harvester serve
gorombo-skill-harvester shutdown
```

Always-on service:

```sh
gorombo-skill-harvester service install
gorombo-skill-harvester service start
gorombo-skill-harvester service stop
gorombo-skill-harvester service restart
gorombo-skill-harvester service status --json
gorombo-skill-harvester service uninstall
```

Service installation requires `READY`. Uninstall removes only the generated service definition and preserves private configuration, recommendations, database state, bindings, tasks, and delivery history.

## Route controls

```sh
gorombo-skill-harvester route test telegram
gorombo-skill-harvester route test session
gorombo-skill-harvester route pause telegram
gorombo-skill-harvester route resume telegram
gorombo-skill-harvester route pause session
gorombo-skill-harvester route resume session
```

Pausing retains durable queued work. Resuming wakes eligible work. In `both` mode, each route keeps independent state and receipts.

## Telegram

After pairing and a successful route test:

- normal text creates a Codex task;
- `/status` reports safe route, queue, and current-task state;
- `/cancel` cancels queued work or requests bounded cancellation of the running task;
- `/help` returns the command list.

A local task can also be cancelled by its safe task ID:

```sh
gorombo-skill-harvester task cancel tsk_00000000000000000000000000000000
```

The example ID is a placeholder.

## Selected Codex task

```sh
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Gorombo Skill Harvester"
gorombo-skill-harvester session create "Gorombo Skill Harvester"
gorombo-skill-harvester session clear
```

Selection is by exact visible name. Gorombo Skill Harvester does not silently redirect delivery and does not pin the task.

## Recommendations

Published recommendations are stored beneath:

```text
<CODEX_HOME>/.gorombo/gorombo-skill-harvester/recommendations/
```

Each proposed skill receives a stable recommendation ID and a readable Markdown file. Alerts include the proposed skill, purpose, reason, use cases, procedure, next action, and relative saved location. Raw database rows and assessment JSON are not user alerts.

## External Harvester intake

A running Gorombo Skill Harvester instance with a ready Telegram route can accept a rendered recommendation from another trusted local integration. The command reads the UTF-8 alert body from standard input:

```sh
gorombo-skill-harvester alert ingest --key STABLE_ALERT_KEY
```

The caller supplies a stable, non-secret key and a human-readable recommendation body. Gorombo Skill Harvester stores the alert durably before delivery and returns one of:

```json
{"result":"queued"}
```

```json
{"result":"existing"}
```

An exact retry with the same key and content returns `existing`. Reusing a key with different content fails closed. The public interface defines local stdin ingestion only; transport between separate systems is outside this command's contract.

## Retry and restart behavior

Completion and delivery work is event-driven. The runtime drains durable work at startup, wakes after a committing producer, and arms only the next known retry or lease deadline.

The completion hook first commits a private handoff. The service accepts that handoff idempotently into SQLite and removes it only after acceptance commits. A retained handoff is safe to replay; malformed or unsafe input fails closed.

Telegram may accept a message before Gorombo Skill Harvester can commit its receipt. If the process stops in that window, acceptance is ambiguous and a retry can duplicate the provider message. Gorombo Skill Harvester reports that uncertainty instead of claiming exactly-once delivery.

A selected Codex task delivery is accepted only after the matching turn reports successful completion. A post-write connection loss is treated as unknown rather than accepted.

## Recovery

Inspect status first and stop the service before a local recovery operation.

If only the runtime heartbeat is `RECOVERY_REQUIRED` and no active owner or broader recovery state exists:

```sh
gorombo-skill-harvester recover runtime --confirm
```

The command changes only the runtime latch to `STOPPED` and requires an explicit restart. It does not clear route, task, recommendation, database, schema, or ownership uncertainty.

Do not manually edit the SQLite database or recommendation files while the runtime or service is active.

## Credential rotation

1. Stop the service.
2. Replace values only in `<CODEX_HOME>/.gorombo/.env`.
3. Keep file access restricted to the current user.
4. Start the service.
5. Run the applicable route test and status check.

Rotating the Telegram token can invalidate the existing bot binding. Pair and test the replacement bot explicitly.

## Common problems

| Status or symptom | Next check |
| --- | --- |
| `NEEDS_ONBOARDING` | Run preflight, verify private configuration, then rerun the selected onboarding command |
| Telegram will not pair | Confirm the sender is allowlisted and the runtime is active |
| Session route is blocked | List tasks and explicitly reselect the exact visible name |
| Service will not install | Confirm `gorombo-skill-harvester status --json` reports `READY` |
| `RECOVERY_REQUIRED` | Preserve private state, stop the service, and inspect the reported recovery domain before acting |

For unresolved problems, follow [Support](../SUPPORT.md).
