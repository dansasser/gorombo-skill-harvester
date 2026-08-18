# Operating Gorombo Skill Harvester

## Read-only status

~~~sh
gorombo-skill-harvester preflight --json
gorombo-skill-harvester doctor --json
gorombo-skill-harvester status --json
gorombo-skill-harvester service status --json
~~~

Status is bounded and redacted. READY means all selected routes are ready. DEGRADED means a selected component needs attention. RECOVERY_REQUIRED pauses unsafe work.

## Runtime and service

Foreground diagnostics:

~~~sh
gorombo-skill-harvester serve
gorombo-skill-harvester shutdown
~~~

Always-on service:

~~~sh
gorombo-skill-harvester service install
gorombo-skill-harvester service start
gorombo-skill-harvester service stop
gorombo-skill-harvester service restart
gorombo-skill-harvester service status --json
gorombo-skill-harvester service uninstall
~~~

Install requires READY. Stop and restart first request graceful local shutdown and verify runtime ownership is released. Uninstall preserves private state.

## Routes

~~~sh
gorombo-skill-harvester route test telegram
gorombo-skill-harvester route test session
gorombo-skill-harvester route pause telegram
gorombo-skill-harvester route resume telegram
gorombo-skill-harvester route pause session
gorombo-skill-harvester route resume session
~~~

Pausing a route retains its durable queued work. Resuming wakes eligible work. In both mode, route state and receipts remain independent.

## Selected Codex task

~~~sh
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Gorombo Skill Harvester"
gorombo-skill-harvester session create "Gorombo Skill Harvester"
gorombo-skill-harvester session clear
~~~

Selection is by exact visible name. Duplicate names, a renamed task, a missing task, an inaccessible task, or a private-ID mismatch require explicit reselection. Gorombo Skill Harvester does not silently choose another task and does not pin it.

## Telegram

Send /start to create a pairing request. Approve the returned code locally with:

~~~sh
gorombo-skill-harvester pair ABC123
~~~

After the route test succeeds:

- normal text creates a Codex task;
- /status reports safe route, queue, and current-task state;
- /cancel cancels a queued task or requests bounded cancellation of the running task;
- /help returns the command list.

A local task can also be cancelled by its safe task ID:

~~~sh
gorombo-skill-harvester task cancel tsk_00000000000000000000000000000000
~~~

The example ID is a placeholder.

## Recommendations

Published files are beneath:

~~~text
<CODEX_HOME>/.gorombo/gorombo-skill-harvester/recommendations/
~~~

Each propose-new recommendation has a stable rec_ identifier. Alerts contain readable recommendation fields and the relative Markdown location. Do not use raw database rows or assessment JSON as user alerts.

## Retry, ambiguity, and restart

Queued and retryable work is event-driven. The runtime drains durable work at startup, wakes after a committing producer, and arms only the next known due time or lease expiry.

The completion hook first commits a private handoff record. The running service drains it on a filesystem event and at startup, accepts it idempotently into SQLite, and removes the record only after that acceptance commits. A retained record is safe to replay; an unsafe or malformed record fails closed and appears as a completion-handoff error in status.

Telegram may accept a message before Gorombo Skill Harvester can commit its receipt. If the process dies in that window, the attempt is recorded as ambiguous and a retry can duplicate the provider message. Do not relabel that state as exactly once.

A selected Codex task delivery is accepted only after the matching turn reports successful completion. A post-write connection loss is treated as unknown rather than accepted.

## Recovery

Inspect status first. Stop the service before a local recovery operation.

If only the runtime heartbeat is RECOVERY_REQUIRED and ownership plus storage invariants can be proven:

~~~sh
gorombo-skill-harvester recover runtime --confirm
~~~

The command changes only the runtime latch to STOPPED and reports that an explicit restart is required. It does not clear route, task, completion, recommendation, database, schema, or ownership uncertainty. If it reports recovery_scope_incomplete, preserve state and investigate the reported domain before retrying.

Version 0.1.0 exposes no backup, restore, replay, or private-data deletion command. Do not manually edit the SQLite database or recommendation files while the runtime or service is active.

## Credential rotation

1. Stop the service.
2. Replace values only in <CODEX_HOME>/.gorombo/.env.
3. Keep file access restricted to the current user.
4. Start the service.
5. Run the relevant route test and status check.

Rotating the Telegram token can invalidate the existing bot binding. Pair and test the new bot explicitly; do not copy private IDs into public configuration.
