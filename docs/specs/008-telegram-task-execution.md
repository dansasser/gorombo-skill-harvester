# SDD 008: Telegram task execution

## 1. Status and ownership

- Status: implementation baseline
- Version: 1
- Governs: authorized Telegram text tasks, durable task state, Codex process execution, cancellation, restart classification, and final Telegram replies
- Depends on: SDD 007 authorization, SDD 010 runtime ownership
- Excludes: Harvester assessment and selected-session alert delivery

## 2. Task boundary

A Telegram alert is system-originated. A Telegram task is user-originated text from an ACTIVE paired binding. Only a paired allowed user may create a task. The update identity is persisted before Codex starts, so replayed Telegram updates cannot create a second task.

Version 1 accepts nonempty UTF-8 text up to 16,000 bytes. Control commands are not task text. Attachments are rejected with a readable explanation and no task row.

One task may run at a time per active binding. Additional valid text is durably QUEUED in received order. Global runtime concurrency defaults to one Codex task, so public hosts have a bounded resource profile.

## 3. Private task policy

The private environment may define:

~~~text
GOROMBO_SKILL_HARVESTER_TASK_CWD
GOROMBO_SKILL_HARVESTER_TASK_SANDBOX
~~~

The working directory must be an existing absolute directory discovered at runtime from private configuration. It is never copied into tracked configuration, safe status, or an alert. The sandbox is exactly read-only, workspace-write, or danger-full-access; the default is read-only.

The runtime invokes Codex with approval policy never and the selected sandbox. Choosing workspace-write or danger-full-access is an explicit private host configuration decision. Gorombo Skill Harvester never upgrades the sandbox based on Telegram text.

## 4. Durable states

tasks.state:

~~~text
ACCEPTED -> QUEUED -> RUNNING -> SUCCEEDED
                         |        FAILED
                         |        CANCELLED
                         |        RECOVERY_REQUIRED
                         -> WAITING_APPROVAL
~~~

Version 1 does not execute a protected action after Codex requests an unavailable interactive approval. Such a run becomes WAITING_APPROVAL and sends a readable host-action instruction. It is not automatically approved from Telegram.

Each execution creates task_runs with a monotonically increasing run number and a private Codex thread ID. The task request text and final result are private runtime data and never appear in general status or logs.

## 5. Codex execution

The runtime resolves the Codex executable from PATH at runtime and verifies a stable compatible version. It does not persist the machine path. Before starting work it checks codex login status or an available CODEX_API_KEY inherited from the private host environment.

A new task uses:

~~~text
codex exec --json --sandbox SANDBOX --cd CWD -
~~~

The request is sent over a non-terminal UTF-8 stdin pipe. Arguments are separate process arguments, not a shell string. The runtime parses bounded JSONL events, captures the created thread ID privately, tracks a completed turn, and selects the final agent message as the result. Raw tool output and commands are not sent to Telegram.

A continuing task may resume only its stored task thread:

~~~text
codex exec resume --json THREAD_ID -
~~~

No task is resumed merely because it is the most recent session.

Success requires a completed turn, exit status zero, and a bounded final agent message. Process start alone is not success.

## 6. Cancellation

/cancel finds only the caller's active or queued task. A queued task becomes CANCELLED transactionally. A running task receives an abort signal, then a bounded forced termination if it does not stop. The task remains RUNNING until the process exit is observed and the cancellation state commits.

Cancellation never marks a provider delivery receipt accepted. The user receives a readable cancellation result identified by task ID.

## 7. Result messages

Success:

~~~text
Task complete

<safe bounded final result>

Task ID: tsk_...
~~~

Authentication failure:

~~~text
Codex is not authenticated.

Authenticate Codex on the host, then send the task again.
~~~

Approval required:

~~~text
Task is waiting for host approval.

Open the host task and resolve the request there.
Task ID: tsk_...
~~~

Failure:

~~~text
Task failed.

<safe category and corrective action>
Task ID: tsk_...
~~~

The final Telegram reply is delivered durably. Version 1 stores a typed task-result delivery item in the same dispatcher boundary, distinguished from recommendation delivery by the task record and stable update identity. A result is not discarded when Telegram is unavailable.

## 8. Restart recovery

On startup:

- ACCEPTED becomes QUEUED.
- QUEUED remains eligible in received order.
- RUNNING with a live owned process remains running only in the same runtime; after a process restart it becomes RECOVERY_REQUIRED because external completion is uncertain.
- SUCCEEDED with no accepted Telegram reply schedules the stored result for delivery.
- FAILED, CANCELLED, and already-replied SUCCEEDED remain terminal.
- WAITING_APPROVAL remains visible and does not execute until a later explicitly specified host flow exists.

A task in RECOVERY_REQUIRED is never blindly submitted again. The operator may inspect it and explicitly create a new task; history remains.

## 9. Security and limits

- Authorization and pairing are rechecked immediately before process launch.
- The request is never placed in process arguments.
- The process environment is allowlisted and receives no Telegram bot token unless the task itself needs the Harvester runtime, which version 1 does not.
- JSONL events are bounded to 1 MiB per line and 16 MiB total.
- Final Telegram text is bounded by the provider budget and safely shortened at a Unicode boundary.
- Raw exceptions, environment values, private paths, user/chat IDs, and thread IDs are excluded from replies and safe events.
- A Telegram task cannot call Harvester operator commands such as pair, unpair, route changes, replay, restore, or private-data deletion through an internal shortcut.

## 10. APIs and commands

~~~text
tasks.accept(update, binding)
tasks.claim(workerId)
tasks.execute(claim, signal)
tasks.complete(claim, result)
tasks.cancel(binding)
tasks.reconcile()
~~~

Telegram commands:

~~~text
/cancel
/status
/help
~~~

/status returns counts and the caller's active task ID/state, not task bodies or private identifiers.

## 11. Tests and acceptance

Tests cover unauthorized and unpaired input, update replay, empty/oversized text, attachment rejection, per-binding ordering, global concurrency, safe process arguments and stdin, auth failure, JSONL bounds, private thread persistence, successful completion, no-final-message failure, approval-required classification, cancellation races, crash recovery, stored-result redelivery, result shortening, and secret/path/identity scans.

Controlled acceptance uses a private paired bot and an isolated test workspace. It proves one successful read-only task, one cancellation, service restart recovery, and a human-readable final reply. The evidence is redacted.

## 12. Version-1 decisions

- Input is text only.
- One active task per binding and one active Codex task globally.
- Default sandbox is read-only.
- Interactive approval is resolved on the host, not by an automatic Telegram approval.
- A post-restart uncertain RUNNING task becomes RECOVERY_REQUIRED rather than being resubmitted.
