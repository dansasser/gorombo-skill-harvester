# SDD 009: Selected Codex session delivery

## 1. Status and ownership

- Status: implementation baseline
- Version: 1
- Governs: discovery by visible session name, private thread binding, test delivery, recommendation turn submission, and route-specific recovery
- Depends on: SDD 005 content, SDD 006 outbox, SDD 010 lifecycle

This route delivers an alert to a selected Codex session. It does not replace the completion hook and does not create a second Harvester completion source.

## 2. User-facing model

During onboarding the user chooses the session route and supplies a visible name. The default offered name is Gorombo Skill Harvester. The runtime may bind an existing exact-name session or create a dedicated session and set its name. The visible name is used in status and Codex search. The user may pin it in the Codex app; Gorombo Skill Harvester performs no pin operation.

The database stores the resolved internal thread ID privately. Normal status, Telegram, recommendations, logs, and safe errors never expose it.

A route is READY only after:

1. the visible name resolves to exactly one accessible thread;
2. the private ID is persisted;
3. the current metadata still reports the selected name; and
4. a human-readable test turn is accepted.

If the requested name is already associated with more than one accessible thread, onboarding asks for a different name and performs no automatic choice.

## 3. Codex capability boundary

The runtime starts codex app-server over a non-terminal stdio pipe and uses newline-delimited JSON-RPC. It sends initialize with clientInfo and capabilities.experimentalApi true, then initialized.

Required methods:

~~~text
thread/list
thread/start
thread/name/set
turn/start
~~~

thread/list uses bounded pagination. Only id, name, status, and cursor fields are retained. Discovery does not resume a thread.

If no exact-name thread exists and creation is requested, thread/start creates a durable non-ephemeral session using the onboarding working directory, then thread/name/set assigns the chosen visible name. The returned internal ID is stored only in session_routes.

Delivery uses turn/start with:

~~~json
{
  "threadId": "<private>",
  "input": [
    {
      "type": "text",
      "text": "<human-readable SDD 005 alert>"
    }
  ]
}
~~~

The text begins with Gorombo Skill Harvester and asks the receiving Codex session to retain the recommendation for review. It contains no raw assessment JSON or internal ID.

## 4. Session route states

~~~text
UNCONFIGURED -> SELECTED -> READY
READY -> BUSY -> READY
READY -> MISSING
READY -> INACCESSIBLE
READY -> RESELECTION_REQUIRED
MISSING or INACCESSIBLE -> SELECTED after explicit selection
~~~

The durable session_routes states are SELECTED, READY, BUSY, MISSING, INACCESSIBLE, and RESELECTION_REQUIRED.

A name change, missing thread, inaccessible metadata, or private-ID mismatch retains the queued alert and marks the route for reselection. It never redirects to another session.

## 5. Delivery result mapping

The adapter waits for the direct turn/start response and matching turn completion notification within the SDD 006 attempt deadline.

| Observation | Adapter result |
|---|---|
| Matching turn completes successfully | accepted with turn ID receipt |
| Thread has an active turn or returns busy | retryable session_busy |
| Thread is missing | routeBlocked session_missing |
| Name no longer matches | routeBlocked session_reselection_required |
| Authentication or access denied | routeBlocked session_auth |
| Connection fails before request write | retryable connection_unavailable |
| Timeout or disconnect after request write | ambiguous completion_unknown |
| Malformed or unknown response | permanent adapter_contract_invalid |

A response that merely assigns a turn ID is not final acceptance. If completion cannot be observed, the result is ambiguous and SDD 006 may retry, so a duplicate session message is possible.

The adapter does not call turn/steer, thread/resume, update_goal, or any different thread as a fallback.

## 6. Active turns and wakeup

When the selected session is BUSY, the outbox row follows normal deterministic retry. No fixed busy poll exists. The earliest retry timer wakes the dispatcher. If a matching Codex completion notification is already available to the runtime, it may also call dispatcher.wake; the durable due time remains authoritative.

After the maximum delivery attempt, the row is DEAD_LETTER. The user can reselection-test the route and explicitly replay it under SDD 006.

## 7. Onboarding and commands

~~~text
gorombo-skill-harvester session list
gorombo-skill-harvester session select "Visible name"
gorombo-skill-harvester session create "Visible name"
gorombo-skill-harvester route test session
gorombo-skill-harvester session clear
~~~

list is read-only and displays bounded visible names and status only. select and create persist one current binding. clear disables the route but preserves recommendation and delivery history.

The onboarding flow names the dedicated session before sending its test alert so it can be located immediately in Codex search.

## 8. Restart and recovery

On startup the runtime verifies the private ID and visible name before claiming a session delivery. If app-server is unavailable, the route is DEGRADED and rows remain retryable or paused according to result classification. A missing thread becomes RESELECTION_REQUIRED and is never recreated silently.

A crash after turn submission but before receipt commit is ambiguous. Recovery retains the SENDING lease until expiry, then uses SDD 006 ambiguity handling.

## 9. Security and privacy

- Internal thread IDs and working directories are private runtime values.
- Session names are bounded to 1 through 120 Unicode scalar values and may not contain controls or secret patterns.
- App Server lines are bounded and parsed as JSON objects.
- Raw notifications, prompts, tool output, and errors are not persisted.
- The alert uses read-only intent and cannot change delivery authority.
- Discovery is metadata-only and never resumes arbitrary sessions.

## 10. Tests and acceptance

Tests cover capability preflight, bounded pagination, exact visible-name selection, dedicated-session creation and naming, test turn, private-ID redaction, duplicate-name refusal, active turn, missing and renamed sessions, connection failure before and after write, matching completion, timeout ambiguity, restart verification, both-mode independence, dead-letter replay, and no pin/steer/resume/goal mutation calls.

Controlled acceptance creates or binds a dedicated test session, names it, sends a readable recommendation, verifies the visible session in Codex search, restarts the runtime, and sends a second test. Stored evidence is redacted.

## 11. Version-1 decisions

- A dedicated visible-name session is the clean default.
- Internal IDs are stored privately and never used as the user-facing name.
- No automatic pinning.
- No automatic redirection or silent recreation when the bound session is missing.
