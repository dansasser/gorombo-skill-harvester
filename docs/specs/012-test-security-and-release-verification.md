# SDD 012: Test, security, and release verification

## 1. Status and purpose

- Status: implementation baseline
- Version: 1
- Governs: deterministic tests, controlled integrations, fault injection, security scanning, package verification, and public release evidence

A release claim is based on inspectable evidence from the packed artifact and controlled private integrations. A passing process exit without assertions is not evidence.

## 2. Test layers

### Unit

Node's built-in test runner covers paths, containment, private environment parsing, redaction, IDs, content normalization, Markdown and alert rendering, config, schema creation, migrations, transactions, leases, retry calculation, Telegram parsing, Codex JSON-RPC parsing, and service descriptor generation.

### Integration with fakes

A fresh isolated Codex root and fake Telegram/Codex transports cover:

- NEEDS_ONBOARDING through READY;
- completion-handoff publication, filesystem-event wake, startup drain, idempotent intake, catalog snapshot, assessment outcomes, publication, visibility, direct fan-out, and acknowledgement;
- Telegram pairing, allowed-user gate, route test, readable alert, and tasks;
- selected-session creation/binding/test delivery;
- telegram, session, and both route independence;
- retries, rate limits, ambiguity, dead letter, replay, and restart;
- service ownership, heartbeat, and endpoint commands.

### Fault injection

Tests interrupt before and after every durable boundary: intake commit, assessment claim/commit, file write/sync/rename, visibility commit, integrity gate, wake, delivery claim, provider acceptance, receipt commit, retry scheduling, pairing commit, task acceptance/start/completion/reply, migration, backup, restore, lock acquisition, and shutdown cleanup.

### Controlled private integration

Separately supplied private configuration proves:

- Telegram /start pairing and local approval;
- readable recommendation delivery;
- one authorized text task and final reply;
- selected Codex session naming, test turn, and restart delivery;
- always-on service restart and queued-work recovery.

No credential or private identifier is copied into the repository or unredacted evidence.

## 3. Security verification

Scans cover the public tree, packed artifact, and the release commit boundary for:

- bot/API tokens and authorization headers;
- .env or private configuration;
- Telegram user/chat IDs and pairing codes;
- Codex thread IDs;
- absolute machine, home, workspace, or installation paths in reusable artifacts;
- databases, WAL/SHM files, logs, recommendations, backups, sockets, locks, and generated service definitions;
- dependency or package residue outside the declared inventory.

Seeded secret tests place recognizable canaries in private inputs and prove they are absent from status, logs, errors, Markdown, alerts, receipts, package bytes, and test artifacts.

## 4. Release evidence matrix

| Evidence | Passing rule |
|---|---|
| Runtime baseline | Supported Node version and built-ins pass; a stable authenticated Codex CLI 0.147.0 or newer passes bounded version, login-status, and App Server availability probes |
| Deterministic suite | All unit, integration, migration, scheduler, restart, and fault tests pass |
| Acceptance trace | Every acceptance-matrix row has a named test or controlled receipt |
| Plugin and skill | Official validators pass on the packed artifact |
| Package inventory | Exact declared public files; no missing link or private residue |
| Content | Golden readable recommendation and Telegram/session alert captures |
| Storage | Schema identity, migration checksum, integrity, and file digest evidence |
| Delivery | Per-route receipts, ambiguity, retry, dead letter, replay, and no completion poll |
| Tasks | Authorization, sandbox, cancellation, restart classification, and final reply |
| Lifecycle | Ownership, automatic start, crash restart, and queued recovery |
| Security | Public and seeded-private scans pass |
| Documentation | Commands and claims match observed behavior |
| Release record | Commit, package hash, lockfile hash, test hashes, validator outputs, and known limits recorded |

## 5. Release gates

Release is blocked by any failing or skipped required test, missing acceptance owner, validator failure, package mismatch, unsupported runtime API, unverified migration, private-data finding, lifecycle failure, controlled Telegram/session failure, documentation overclaim, or unresolved RECOVERY_REQUIRED fixture.

A controlled integration may be skipped only when the release is explicitly marked non-public and the missing capability is not claimed. A public release requires all controlled integrations.

## 6. Verification commands

~~~text
npm run check
npm test
npm run verify
npm pack --dry-run --json
node src/cli.js preflight --json
node src/cli.js status --json
~~~

npm run check performs syntax, skill-reference, package-inventory, identical source/packed test-inventory, and public credential/path checks without executing the deterministic suite. npm run verify performs the same checks and then runs the complete Node test suite. Its packed-install case runs the installed artifact's verifier and complete suite with a one-level self-recursion guard, verifies preflight with a deterministic fake Codex CLI, and then verifies isolated onboarding. Child commands use separate process arguments and never copy .env into outputs. The deterministic fake does not replace the controlled real Telegram, selected Codex task, or always-on lifecycle gates.

## 7. Release record

The generated release record is written outside the npm package inventory. It contains only safe versions, relative artifact names, counts, SHA-256 digests, test identifiers, pass/fail states, and known limitations. It excludes paths, credentials, identities, payload bodies, task text, and provider bodies.

## 8. Verifier coverage

The current verifier proves positive package inventory, identical source and packed test inventories, relative skill references, hook root use, JavaScript syntax, packed installation with its complete deterministic suite, fake-Codex preflight, read-only fresh status, isolated onboarding, and public token/path scans. The deterministic suite contains negative fixtures for runtime secret redaction, path containment, storage identity, ownership, route, task, and recovery failures. Controlled real integration receipts remain a separate public-release gate.

Before universal-directory publication, add release-harness negative fixtures for a seeded public secret, an injected machine path, a missing skill reference, an extra tarball file, and an absent controlled-integration receipt. Each fixture must block publication with a safe reason.

## 9. Version-1 decisions

- No required release gate is silently skipped.
- The packed artifact, not only the checkout, is tested.
- Telegram and selected-session controlled receipts are required before public release.
- Release evidence is safe metadata and hashes, not raw private output.
