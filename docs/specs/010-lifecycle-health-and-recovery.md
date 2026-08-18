# SDD 010: Lifecycle, health, and recovery

## 1. Status and ownership

- Status: implementation baseline
- Version: 1
- Governs: one runtime owner, local control boundary, startup/shutdown, heartbeat, service installation, restart recovery, and safe operator status

## 2. Runtime ownership

One process owns one runtime state root. Ownership is represented by an atomically created runtime lock containing an opaque instance ID, process ID, process start identity, package version, protocol version, and heartbeat time.

A second process may issue read-only status but cannot claim work, unlink endpoints, replace the lock, or start provider transports. Stale-owner recovery requires both a failed process-liveness check and a heartbeat older than the configured stale threshold. An inaccessible process is not presumed dead.

Runtime states:

~~~text
ABSENT -> NEEDS_ONBOARDING -> READY -> STARTING -> RUNNING
RUNNING -> DEGRADED -> RUNNING
RUNNING or DEGRADED -> STOPPING -> STOPPED
Any invariant or ownership uncertainty -> RECOVERY_REQUIRED
~~~

RECOVERY_REQUIRED is fail-closed for provider sends.

## 3. Local control boundary

The running service owns a private local endpoint beneath the runtime directory. On POSIX it is a Unix-domain socket. On Windows it is a named pipe derived from the state-root digest. The reusable package contains no machine path.

The endpoint accepts bounded JSON commands for wake, status, pairing approval, completion submission, route test, task cancellation, pause/resume, and shutdown. Requests have an exact version and command allowlist. The endpoint is local-owner-only. A client timeout is mandatory.

An offline CLI may initialize or inspect storage only when the runtime lock proves no active owner. It never writes an outbox row concurrently with the service.

## 4. Startup sequence

1. Resolve the Codex root and package root at runtime.
2. Check Node version and built-in SQLite support before creating state.
3. Load the private environment without printing values.
4. Validate config and owned path containment.
5. Open storage, verify application ID, migration checksums, quick_check, and foreign keys.
6. Acquire runtime ownership.
7. Start the private completion-handoff watcher and drain all valid records into SQLite.
8. Start the private control endpoint.
9. Reconcile recommendation publication and INTEGRITY_PENDING rows.
10. Recover expired assessment and delivery leases.
11. Reclassify uncertain Telegram tasks.
12. Start the selected Codex session transport when configured.
13. Start Telegram transport when configured.
14. Start the event-driven dispatcher and drain currently due work.
15. Arm the earliest known retry or lease timer.
16. Publish a safe heartbeat and enter RUNNING.

There is no periodic Harvester completion poll.

## 5. Shutdown sequence

1. Enter STOPPING and reject new claims.
2. Stop completion and task intake at the endpoint.
3. Abort Telegram long polling.
4. Cancel owned future timers.
5. Let active adapter calls and Codex tasks settle within their grace periods.
6. Commit results already observed.
7. Leave unresolved provider calls lease-fenced; do not invent success or failure.
8. Close App Server and Telegram transports.
9. Close endpoint and database inside finally cleanup.
10. Remove only endpoint and lock artifacts whose instance identity matches.
11. Write stopped heartbeat and enter STOPPED.

Forced termination relies on SQLite durability, publication reconciliation, task classification, and lease recovery during the next startup.

## 6. Health and status

status --json is safe and bounded:

~~~json
{
  "status": "RUNNING",
  "packageVersion": "0.1.0",
  "onboarding": "COMPLETED",
  "database": "healthy",
  "routes": {
    "telegram": {"selected": true, "state": "READY"},
    "session": {"selected": false, "state": "DISABLED"}
  },
  "outbox": {
    "queued": 0,
    "sending": 0,
    "retryWait": 0,
    "paused": 0,
    "deadLetter": 0
  },
  "tasks": {"queued": 0, "running": 0, "recoveryRequired": 0},
  "nextDueAt": null,
  "heartbeatAgeMs": 0,
  "recoveryRequired": false
}
~~~

It does not contain absolute paths, tokens, Telegram identities, thread IDs, pairing codes, task bodies, recommendation bodies, provider responses, or raw exceptions.

The heartbeat is a private atomic JSON file containing instance ID, state, package version, schema version, monotonic generation, and UTC time. Liveness, ownership, database health, route readiness, and scheduler readiness are separate checks.

## 7. Service installation

The package provides lifecycle adapters selected at runtime:

- systemd user service on Linux;
- launchd user agent on macOS;
- Task Scheduler definition with restart-on-failure settings on Windows.

The generated private service definition uses runtime-discovered executable and package entry paths. Reusable templates use placeholders and relative package references; no machine path is committed to the repository.

Commands:

~~~text
gorombo-skill-harvester service install
gorombo-skill-harvester service start
gorombo-skill-harvester service stop
gorombo-skill-harvester service restart
gorombo-skill-harvester service status
gorombo-skill-harvester service uninstall
gorombo-skill-harvester serve
~~~

install enables start at user login or boot according to the host service manager and configures bounded restart-on-failure. uninstall removes only the generated service definition and never removes private Harvester state. serve is the foreground development and diagnostic mode.

## 8. Recovery

Startup reconciliation handles:

- DRAFT_COMMITTED recommendation without a file;
- matching final file before visibility commit;
- INTEGRITY_PENDING rows after visibility commit;
- expired assessment and delivery leases;
- queued work after commit-before-wake;
- private completion-handoff records after control failure or commit-before-unlink;
- Telegram cursor and task result after process loss;
- RUNNING Telegram task with uncertain completion;
- stale owned endpoint after proven owner death.

Digest mismatch, schema identity mismatch, unsafe path type, uncertain ownership, or private configuration corruption enters RECOVERY_REQUIRED. Recovery preserves data and pauses affected routes. It never overwrites a mismatching owner-visible file or deletes history automatically.

Version 0.1.0 exposes one bounded local recovery operation:

~~~text
gorombo-skill-harvester recover runtime --confirm
~~~

It is allowed only when the existing heartbeat is RECOVERY_REQUIRED, no active owner exists, stale ownership can be proven when present, configuration and storage invariants pass, and no route, task, completion, recommendation, schema, or integrity recovery remains. It acquires normal runtime ownership, rereads the latch, writes and verifies STOPPED, releases only its own lock, and requires a separate explicit restart. It does not open providers, clear durable uncertainty, or remove private data.

service stop and service restart request graceful shutdown through the private endpoint, wait for ownership release, and fail with service_stop_recovery_required rather than starting a second owner when release cannot be proved.

## 9. Update, backup, and restore boundary

Version 0.1.0 exposes no backup, restore, replay, schema-changing update, or private-data deletion command. The private directories are reserved, not evidence that those operations exist.

Migration identity, application identity, integrity, and schema-version checks fail closed. An older package cannot use a newer schema. Any future schema-changing release must add and verify its backup, migration, restore, and rollback boundary before it receives mutation authority.

## 10. Tests and acceptance

Automated tests cover empty-root status, onboarding transition, double start, inaccessible owner, stale owner proof, unsafe lock and endpoint types, endpoint client timeout, startup ordering, completion-handoff publication, filesystem-event wake, startup drain, conflict and malformed-record retention, no completion poll, retry and lease timers, queued and INTEGRITY_PENDING recovery, task uncertainty and cancellation, graceful and forced shutdown, cleanup in finally, heartbeat redaction, bounded runtime-latch recovery, service descriptor generation on all supported hosts, uninstall state preservation, packed installation with the complete deterministic suite, and secret/path scans.

Controlled lifecycle publication acceptance installs the service on each claimed host family, proves automatic start, kills the runtime, observes bounded restart, verifies queued alert recovery, and records redacted evidence. Automated descriptor tests do not replace that controlled host evidence.

## 11. Version-1 decisions

- One runtime owner per state root.
- Local control is socket or named pipe, never a public network listener.
- Service uninstall preserves private data.
- Version 0.1.0 has no private-data deletion command.
