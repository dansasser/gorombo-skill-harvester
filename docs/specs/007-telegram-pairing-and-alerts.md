# SDD 007: Telegram pairing and alerts

## 1. Status and ownership

- Status: implementation baseline
- Version: 1
- Governs: Telegram configuration, first-use pairing, inbound authorization, Bot API transport, alert formatting, provider-result classification, update cursors, and restart behavior
- Depends on: SDD 002 paths and secrets, SDD 004 storage, SDD 005 content, SDD 006 outbox
- Excludes: Telegram task execution, which is governed by SDD 008

## 2. Required behavior

Gorombo Skill Harvester connects one configured Telegram bot to one or more explicitly allowed Telegram users. A bot token alone does not authorize inbound work. Every inbound update is checked against the private allowed-user setting and an approved pairing before it may create a task or receive private status.

The tracked package contains only placeholder environment names. Runtime configuration is read from the documented private environment file beneath the runtime-discovered Codex root or from the process environment. A token, allowed-user value, chat identity, pairing code, or Bot API URL containing a token must never be written to tracked files, normal logs, recommendations, safe receipts, or user-facing session alerts.

Required private environment names:

~~~text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
~~~

The allowed-user value is a comma-separated set of positive decimal identifiers treated as strings. Empty entries, signs, whitespace inside an identifier, scientific notation, duplicates, and non-decimal values fail onboarding.

## 3. Telegram transport

The adapter uses the HTTPS Bot API with the configured token and the methods getMe, getUpdates, and sendMessage. The token is inserted only into the in-memory request URL immediately before the request. Safe diagnostics identify only the method and a bounded error category.

getUpdates is a provider long poll, not a Harvester completion poll. The runtime keeps at most one getUpdates request active. The timeout is bounded, shutdown aborts the request, and the next offset is persisted as the setting telegram.update_cursor only after every accepted update at or below that offset has reached a durable handling boundary.

sendMessage sends plain text. Gorombo Skill Harvester does not require a Telegram topic or message-thread identifier. The destination is the approved chat identity stored in the private binding.

## 4. Pairing model

Pairing is initiated in Telegram and approved locally.

1. An allowed, unpaired user sends /start.
2. The runtime generates six cryptographically random uppercase hexadecimal characters.
3. It stores only an HMAC-SHA-256 digest of the code, keyed by the in-memory bot token and domain separated by bot identity. The plaintext code is returned to Telegram and is not persisted.
4. The pending request stores bot, user, and chat identities privately and expires after one hour.
5. Repeating /start while the same pending request is valid replaces it with a new code and invalidates the older code.
6. The user runs gorombo-skill-harvester pair CODE locally.
7. Approval verifies the digest with constant-time comparison, atomically marks the request USED, and creates or reactivates the matching telegram_bindings row.
8. The runtime sends a confirmation to the bound chat.

The Telegram response is:

~~~text
Pairing code: ABC123

Approve locally with:
gorombo-skill-harvester pair ABC123
~~~

The command accepts exactly one code. Unknown, expired, already-used, or malformed codes fail without changing a binding. Pairing codes never appear in logs or status.

Pairing states are PENDING, APPROVED, EXPIRED, REJECTED, and USED. Bindings are ACTIVE, REVOKED, or RECOVERY_REQUIRED. Only ACTIVE is authorized.

## 5. Inbound authorization

For every Telegram update:

1. Validate the update shape and bounded size.
2. Extract the sender identity and chat identity as decimal strings.
3. If the sender is not in TELEGRAM_ALLOWED_USER_IDS, record only unauthorized_update and do not reply with private information.
4. If the sender is allowed but not paired, accept only /start; other text receives a short instruction to send /start.
5. If the sender is paired but the update chat differs from the binding, reject it and require re-pairing.
6. Persist the Telegram update identity before dispatching its command or task.
7. A repeated update identity returns the stored result and cannot create a second task.

Supported control commands are /start, /status, /cancel, and /help. Other nonempty text is delegated to SDD 008. Bot username suffixes are normalized only for these exact commands.

## 6. Alert adapter

The adapter receives a validated SDD 005 DeliveryEnvelope and a private active binding. It sends envelope.plainText and never serializes the recommendation object as the Telegram message.

The message must contain the proposed skill name, why it is recommended, at least one use trigger, at least one procedure step, next action, recommendation ID, and relative saved location. The Telegram budget is 4096 UTF-8 characters; version 1 renders one message within that budget and does not split a recommendation across messages.

Provider results map to SDD 006:

| Observation | Adapter result |
|---|---|
| HTTP success with valid message_id | accepted |
| HTTP 429 with valid retry_after | rateLimited |
| Network failure before request bytes are written | retryable |
| Timeout or connection loss after request may have been written | ambiguous |
| Token rejected or bot blocked | routeBlocked |
| Invalid chat or forbidden destination | routeBlocked |
| Other bounded 5xx | retryable |
| Malformed success or unsupported response | permanent adapter_contract_invalid |

The provider receipt reference is the Telegram message identifier represented as a string. Safe receipt JSON may store the provider method, rendered digest, and acceptance time; it stores no user/chat identity or response body.

## 7. Route readiness and test

Telegram route states follow SDD 004. READY requires:

- valid private token and allowed-user values;
- getMe success;
- at least one ACTIVE binding for an allowed user;
- a successful route test for the current route configuration revision.

route test telegram enqueues a human-readable test message through the same outbox and adapter. It does not call sendMessage outside durable delivery.

Token rotation makes the route CONFIGURED until getMe and binding verification pass. It does not delete recommendations or delivery history.

## 8. Concurrency, restart, and shutdown

The Telegram update loop and alert adapter are owned by the single SDD 010 runtime. There is one long poll and one active send for the route. On restart the runtime loads the durable cursor, expires old pairing requests, recovers SDD 006 leases, drains due alerts, then resumes getUpdates.

A crash after Telegram accepts a message but before the receipt commit is ambiguous and may duplicate on retry. Status must describe that honestly. Durable generation identity prevents a second outbox row but cannot make Telegram acceptance transactional.

Shutdown aborts the long poll, stops new update dispatch, waits for the bounded active send, leaves unresolved SENDING rows fenced, and closes storage in a finally path.

## 9. Security and privacy

- The bot token is read into memory only when needed and is never returned by status.
- Telegram identifiers are private database values and are absent from general status.
- Pairing is allowed-user-first; possession of a bot username is insufficient.
- Bot API bodies, raw updates, task text, and response bodies are not logged.
- All persisted update and error objects use explicit allowlists and bounds.
- Pairing approval is local and cannot be invoked by a Telegram task.
- No webhooks or public listener are required.

## 10. Commands and APIs

~~~text
telegram.start(signal)
telegram.stop()
telegram.getIdentity()
telegram.sendAlert(envelope, signal)
pairing.begin(update)
pairing.approve(code)
pairing.revoke(binding)
route.test("telegram")
~~~

CLI:

~~~text
gorombo-skill-harvester pair CODE
gorombo-skill-harvester route test telegram
gorombo-skill-harvester status --json
~~~

## 11. Tests and acceptance

Tests cover strict configuration, getMe, unauthorized users, unpaired commands, code shape, code replacement, one-hour expiry, local approval, binding persistence, confirmation delivery, update replay, cursor commit, readable alerts, 4096-character rendering, every provider result class, ambiguous acceptance, token rotation, startup drain, long-poll abort, and secret/private-identity scans.

Acceptance evidence contains redacted request fakes, exact pairing and binding states, outbox/receipt rows, restart traces, and a controlled real-bot receipt supplied through private configuration. No real credential is part of the repository or test fixtures.

## 12. Version-1 decisions

- not-a-skill and extend-existing are recorded without an alert.
- SDD 006's eight-attempt retry and dead-letter policy applies.
- Telegram task input is text in SDD 008.
- Telegram topics are not part of the route contract.
