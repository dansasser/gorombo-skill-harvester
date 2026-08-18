# SDD 002: Paths, configuration, and secrets

## 1. Metadata and revision history

- Status: Historical design draft; the implemented subset and current deviations are governed by source, tests, and SDDs 007-012
- Specification owner: Gorombo Skill Harvester platform and security boundary
- Reviewers: product owner, implementation reviewer, security reviewer
- Version: 0.1.0
- Date: 2026-08-16
- Governs: root resolution, relative paths, private layout, configuration, environment loading, containment, permissions, redaction, and credential rotation

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-16 | Initial implementation-level specification |

## 2. Governing decisions and requirements

This specification implements PATH-001, PATH-002, PATH-003, SEC-001, SEC-002, and SEC-003.

It owns ACC-008 through ACC-013 and the path, secret, and redaction portions of ACC-001 through ACC-005, ACC-018, and ACC-040.

Confirmed decisions:

1. Repository-owned paths are relative to the repository or skill root.
2. Runtime-owned paths are derived from a discovered Codex root.
3. Gorombo mutable state lives beneath <CODEX_HOME>/.gorombo/.
4. The real environment file is <CODEX_HOME>/.gorombo/.env, never inside the installed skill.
5. No path, key, token, identity, or session ID is hardcoded or committed.
6. One component is the path authority.

## 3. Purpose, goals, and non-goals

### 3.1 Purpose

Provide one implementable authority for locating the Codex root, constructing every owned path, loading non-secret configuration and secret values, rejecting escapes, applying private permissions, and preventing sensitive values from reaching public or diagnostic surfaces.

### 3.2 Goals

- Work from a configured or documented fallback Codex root without a developer path.
- Store all Gorombo Skill Harvester mutable state below .gorombo.
- Keep tracked paths relative.
- Give modules named paths instead of allowing ad hoc joins.
- Parse the private environment file without executing it.
- Keep secrets out of config, SQLite, Markdown, logs, status, fixtures, and crash output.
- Make clean install, rotation, and permission behavior testable.

### 3.3 Non-goals

- Validating a Telegram token with the provider; SDD 007 owns that.
- Persisting Telegram or session bindings; SDD 004 supplies storage and SDDs 007/009 own semantics.
- Selecting a service manager.
- Defining repository install destination.
- Supporting arbitrary user-selected state directories in reusable configuration.

## 4. Terminology

- Codex root: the resolved private Codex data directory represented as <CODEX_HOME>.
- Gorombo root: <CODEX_HOME>/.gorombo/.
- Product runtime root: <CODEX_HOME>/.gorombo/gorombo-skill-harvester/.
- Project root: repository or installed package root used for tracked relative paths.
- Path authority: the only module allowed to resolve, join, normalize, create, or permission owned paths.
- Named path: a path returned by semantic name, such as database or recommendations.
- Reusable configuration: tracked package data or persistent config.json.
- Runtime-supplied root: a root supplied by the environment or host at execution time.
- Containment: proof that an owned path resolves below its expected root after link-aware checks.
- Secret reference: a variable name such as TELEGRAM_BOT_TOKEN, never its value.
- Safe value: a bounded value that passed the redaction and output policy.

## 5. Actors and journeys

- Installer places public package files using project-relative entries; it does not create a real .env.
- Agent invokes readiness, which asks PathAuthority to resolve and inspect named paths.
- User creates or edits <CODEX_HOME>/.gorombo/.env as documented.
- Runtime loads config.json and designated secret variables.
- Operator rotates a token, restarts or reloads through the defined operation, and performs a route test.
- Diagnostic code sends candidate output through the central redactor before emission.

## 6. Inputs, outputs, preconditions, and postconditions

### 6.1 Root resolution input

- optional one-shot test or operator root supplied outside reusable configuration;
- CODEX_HOME process environment value;
- host user-home discovery for the documented fallback;
- operation mode: inspect-only or create-owned;
- required named path set.

### 6.2 Root resolution order

1. A one-shot explicit root passed by a trusted local invocation.
2. A nonempty CODEX_HOME environment value.
3. The current user-home directory joined with the relative component .codex.
4. Failure with codex_root_unresolved.

Every candidate is converted to an absolute normalized path at runtime. A relative candidate, empty value, inaccessible parent, non-directory existing target, or ambiguous home fails. No resolved absolute path is written into tracked files or reusable config.

### 6.3 Named path output

~~~text
codexRoot
goromboRoot             .gorombo
environmentFile         .gorombo/.env
productRoot             .gorombo/gorombo-skill-harvester
configFile              .gorombo/gorombo-skill-harvester/config.json
databaseFile            .gorombo/gorombo-skill-harvester/state.sqlite3
recommendationsDir      .gorombo/gorombo-skill-harvester/recommendations
runtimeDir              .gorombo/gorombo-skill-harvester/run
runtimeLock             .gorombo/gorombo-skill-harvester/run/runtime.lock
wakeEndpoint            .gorombo/gorombo-skill-harvester/run/wake
heartbeatFile           .gorombo/gorombo-skill-harvester/run/heartbeat.json
logsDir                 .gorombo/gorombo-skill-harvester/logs
backupsDir              .gorombo/gorombo-skill-harvester/backups
recoveryDir             .gorombo/gorombo-skill-harvester/recovery
~~~

Callers receive opaque named-path results. Persistent records store only product-root-relative values such as recommendations/rec_x.md.

### 6.4 Postconditions

Create-owned mode creates only named owned directories and requested files. Inspect-only mode performs no creation. Every returned path has passed containment and link checks. Permissions are applied or readiness reports permission_unverified or permission_unsafe.

## 7. APIs, commands, configuration, and events

### 7.1 PathAuthority API

~~~text
resolveCodexRoot(input) -> ResolvedRoot | PathError
inspectLayout(root) -> LayoutInspection
ensureOwnedLayout(root, requestedNames) -> LayoutResult
getNamedPath(name) -> AbsoluteRuntimePath
toStoredRelative(name, absolutePath) -> RelativeStoredPath
resolveStoredRelative(name, relativePath) -> AbsoluteRuntimePath
verifyContainment(parentName, candidate) -> ContainmentResult
~~~

No other module may call a general path join for runtime-owned files.

### 7.2 Configuration schema version 1

~~~json
{
  "configVersion": 1,
  "routeMode": "both",
  "telegram": {
    "enabled": true,
    "tokenEnv": "TELEGRAM_BOT_TOKEN"
  },
  "session": {
    "enabled": true
  },
  "harvester": {
    "completionAdapter": "codex-goal-completion-v1",
    "catalogRoots": [
      {"anchor": "codex-root", "relativePath": "skills", "origin": "codex", "precedence": 100},
      {"anchor": "plugin-root", "relativePath": "skills", "origin": "plugin", "precedence": 200}
    ]
  },
  "contentPolicyVersion": 1
}
~~~

Allowed keys are exact. Unknown keys fail validation. tokenEnv must equal an approved variable-name pattern and defaults to TELEGRAM_BOT_TOKEN. The token value is forbidden. Session name and internal ID are stored in private database records, not config.json.

completionAdapter is exactly codex-goal-completion-v1 in configuration version 1. Each catalog root has only anchor, relativePath, origin, and precedence. anchor is codex-root or plugin-root; relativePath passes section 8.2; origin is 1 to 64 safe lowercase characters; precedence is an integer from 0 through 10000. Duplicate anchor plus relativePath pairs fail. Resolved absolute catalog paths are runtime-only and never written back to config.

### 7.3 Configuration precedence

1. One-shot local command options for test roots and non-secret route choices.
2. Designated process environment values for root and secrets.
3. config.json for durable non-secret product settings.
4. documented defaults.

A command-line token option does not exist. Reusable config cannot contain an absolute state override.

### 7.4 Environment file grammar

- Maximum file size: 64 KiB.
- Encoding: UTF-8; invalid bytes fail.
- A comment line has # as its first non-space character. Inline # is part of the value.
- Each other nonblank line is NAME=VALUE.
- NAME matches [A-Z_][A-Z0-9_]{0,127}.
- Leading and trailing ASCII space or tab around NAME and the equals sign is ignored.
- An unquoted value is the remainder after the equals sign with leading and trailing ASCII space or tab removed.
- A quoted value begins with a single or double quote after optional ASCII space or tab and ends with the same quote as the last non-space character. The two delimiters are removed.
- Quote contents are literal. Because escapes are unsupported, the matching delimiter cannot occur inside its quoted value. Any non-space text after the closing delimiter, an unmatched delimiter, or a quoted multiline value fails.
- Empty decoded values are allowed by the parser but fail later when the named setting requires a nonempty secret.
- Duplicate names fail.
- Shell expansion, command substitution, variable interpolation, export statements, multiline values, and escapes that execute behavior are not supported.
- The file is parsed as data and is never sourced by a shell.
- A secret value may be at most 4096 UTF-8 bytes and may not contain NUL.

Golden decoding examples:

| File text | Decoded value |
|---|---|
| TOKEN=abc#123 | abc#123 |
| TOKEN = abc | abc |
| TOKEN='abc 123' | abc 123 |
| TOKEN="abc 123" | abc 123 |

TOKEN="abc"tail, TOKEN='abc\'def', export TOKEN=abc, and TOKEN=$(command) fail.

### 7.5 Stable events

path.root_resolved, path.layout_created, config.loaded, config.rejected, secret.missing, secret.rotated, permission.unverified, and redaction.applied. Event values contain path names and reason codes, not absolute paths or secrets.

## 8. Exact data, file, and validation rules

### 8.1 config.json

- UTF-8 JSON with a final newline.
- Maximum 64 KiB.
- Written through same-directory temporary file, file sync, atomic replace, and parent-directory sync where available.
- Private file permissions.
- Canonical serializer orders keys as shown in 7.2.
- No comments and no secret values.

### 8.2 Stored relative paths

A stored relative path:

- uses slash separators;
- is nonempty;
- contains no absolute prefix, drive designator, UNC form, empty segment, dot segment, parent segment, NUL, control character, or trailing separator;
- has at most 16 segments and 512 UTF-8 bytes;
- is resolved only beneath its named parent;
- is rejected if any existing component is a symbolic link, junction, reparse point, or other redirecting object not explicitly owned and verified by PathAuthority.

### 8.3 Secret registry

The runtime maintains an in-memory registry of loaded secret values and their derived redaction forms. It stores no plaintext secret in SQLite. It may keep a process-local SHA-256 fingerprint to detect a change; the fingerprint is never logged or returned.

### 8.4 Public environment example

The tracked .env.example contains names and comments only. It may include:

~~~text
# Place the real value in <CODEX_HOME>/.gorombo/.env
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
~~~

The placeholder must fail secret-shape validation if copied unchanged.

## 9. State machines

### 9.1 Configuration

~~~text
ABSENT -> VALID
ABSENT -> INVALID
VALID -> VALID (same bytes)
VALID -> CHANGED -> VALID after atomic commit
VALID -> INVALID (external edit)
INVALID -> VALID after correction
~~~

### 9.2 Secret reference

~~~text
MISSING -> PRESENT_UNVERIFIED
PRESENT_UNVERIFIED -> VERIFIED by route adapter
VERIFIED -> ROTATED_UNVERIFIED
ROTATED_UNVERIFIED -> VERIFIED or INVALID
INVALID -> PRESENT_UNVERIFIED after correction
~~~

### 9.3 Permission result

PRIVATE, UNVERIFIED, or UNSAFE. UNSAFE prevents READY. UNVERIFIED produces DEGRADED unless the approved platform profile declares that permission proof is unavailable and documents the residual risk.

## 10. Algorithms

### 10.1 Contained creation

1. Resolve and inspect the existing Codex root.
2. Reject a redirecting root.
3. Walk each existing component with no-follow metadata checks.
4. Compare its resolved real path to the expected ancestor.
5. Create one missing component at a time with private permissions.
6. Reinspect the created component before continuing.
7. Open files with no-follow and create-new or exact-replace semantics.
8. Revalidate containment immediately before atomic rename.
9. Never use a path returned by an untrusted record without toStoredRelative and resolveStoredRelative validation.

### 10.2 Configuration load

1. Read bounded bytes without following a link.
2. Decode UTF-8.
3. Parse JSON.
4. Reject duplicate or unknown keys through the schema validator.
5. Validate route consistency.
6. Resolve only approved secret variable names.
7. Produce separate SafeConfig and SecretHandle objects.
8. Destroy temporary plaintext buffers when no longer needed where the runtime permits.

### 10.3 Redaction

1. Reject secret-bearing objects at type boundaries.
2. Replace exact loaded secret values before formatting.
3. Replace known token patterns, authorization headers, bot API URL token segments, pairing codes, private IDs, absolute runtime paths, and home-path fragments.
4. Bound the result.
5. Emit only the redacted form.
6. If redaction cannot prove safety, emit a reason code and correlation ID instead of the original value.

## 11. Concurrency, transactions, locks, and idempotency

- Path creation is serialized by the runtime ownership lock.
- create-owned operations are idempotent only when an existing object has the required type, containment, and permission state.
- Atomic config replacement uses an expected current digest to avoid lost updates.
- Secret reload swaps a validated in-memory snapshot atomically; in-flight calls retain the prior snapshot only until completion.
- Read-only status never changes permissions or creates paths.
- Temporary names are random, private, and cleaned only when ownership is proven.
- A competing instance cannot remove an active lock, environment file, or wake endpoint.

## 12. Error, retry, timeout, cancellation, and crash behavior

| Condition | Result |
|---|---|
| Root unresolved | NEEDS_ONBOARDING, codex_root_unresolved |
| Relative or malformed root candidate | Reject input; no creation |
| Traversal or link escape | RECOVERY_REQUIRED, path_containment_failed |
| Missing .env | NEEDS_ONBOARDING, telegram_token_missing when Telegram selected |
| Invalid config | NEEDS_ONBOARDING before first READY; otherwise DEGRADED |
| Unsafe permissions | RECOVERY_REQUIRED or DEGRADED according to proof and policy |
| Config write crash before rename | Prior config remains authoritative |
| Crash after rename before directory sync | Reinspect digest on restart; uncertain state is RECOVERY_REQUIRED |
| Credential reload fails | Keep prior verified in-memory credential for current process, mark DEGRADED, and do not overwrite files |
| Token rotation | Preserve history; route adapter revalidates before READY |

Path and config operations do not retry permission or containment failures. Transient file-busy errors use bounded retries from SDD 004.

## 13. Security, authorization, privacy, redaction, and permissions

Threats include public-package secret leakage, directory traversal, link swaps, broad file access, process-list token exposure, provider-error leakage, malicious completion evidence, crash dumps, and fixture contamination.

Controls:

- no secret command-line options;
- private environment and config files;
- least-access directories;
- no-follow containment checks;
- one secret-handle type with no default string conversion;
- central structured logging with allowlisted fields;
- outbound content through SDD 005 safe models;
- database columns reject secret-bearing fields;
- tests seed unique canary secrets and scan every artifact;
- public history scan covers the release history boundary set by SDD 012.

On permission-capable hosts, directories are owner-only and files are owner read/write only. On ACL-based hosts, inherited broad access is removed or explicitly rejected. The implementation tests effective access rather than assuming a numeric mode proves privacy.

## 14. Observability, status, health, and logs

Status may report named path states, config version, selected secret variable name, secret present boolean, permission state, and safe reason codes. It may not report absolute paths by default. Doctor may report root origin as explicit, environment, or fallback without the resolved value.

Metrics include config_load_success, config_load_failure by reason, containment_rejection, permission_failure, redaction_count by category, and secret_reload_result. Metrics contain no identities.

## 15. Installation, migration, compatibility, backup, and rollback

- Public install ships .env.example only.
- First onboarding creates .gorombo and product layout.
- configVersion migrations are explicit pure transformations over non-secret data.
- The previous config digest and bytes are backed up privately before a nontrivial migration.
- Backups exclude .env.
- Restore never overwrites .env.
- An older package that cannot parse configVersion returns RECOVERY_REQUIRED.
- Credential rotation uses edit plus explicit reload or restart plus route test; no recommendation or pairing history is deleted automatically.
- SDD 007 decides whether a token that identifies a different bot requires re-pairing.

## 16. Test specification

1. Explicit root, CODEX_HOME root, and user-home fallback.
2. Missing, relative, file-valued, inaccessible, and malformed roots.
3. Every traversal, absolute stored path, drive/UNC form, link, junction, and race fixture.
4. Clean creation inventory entirely below .gorombo.
5. Inspect-only performs no write.
6. Config unknown keys, duplicate keys, size, encoding, and atomic replacement.
7. Environment grammar, duplicate values, quotes, placeholders, and no expansion.
8. Effective private permissions.
9. Seeded secrets absent from status, logs, SQLite, recommendations, provider errors, fixtures, and crash output.
10. Token rotation and failed reload preserve durable history.
11. Repository and history scan for machine paths, keys, identities, and generated state.
12. Concurrent creation and stale temporary artifact ownership.

## 17. Objective acceptance evidence

- isolated filesystem inventories;
- exact config and environment fixtures;
- containment negative-case snapshots proving outside paths unchanged;
- effective-access reports;
- captured redacted outputs scanned for seeded canaries;
- database and recommendation scans;
- public-tree and selected-history scan report;
- before and after credential-rotation state;
- traceability for ACC-008 through ACC-013 and shared cases.

## 18. Unresolved and deferred decisions

- SDD 011 must select the final package entry mechanism while preserving project-relative paths.
- SDD 010 must define the exact secret reload and service restart commands.
- SDD 007 must define bot-identity continuity after token rotation.
- Final supported platform profiles and their effective permission probes require implementation validation before release.
- No arbitrary alternate runtime root is persisted in config version 1.

## 19. Cross-spec dependencies and traceability

| Contract | Owner | Used by |
|---|---|---|
| Readiness responses | 001 | 002 error mapping |
| Named paths and SafeConfig | 002 | all runtime specs |
| SQLite files and backup | 004 | 002 |
| Safe recommendation model | 005 | 002 redaction boundary |
| Telegram token validation | 007 | 002 |
| Lifecycle lock and reload | 010 | 002 |
| Public tree scan | 012 | 002 |

### 19.1 Requirement-to-test trace

Test IDs 002-TNN refer to the correspondingly numbered case in section 16 and remain stable if the case prose is expanded.

| Requirement | Implementation component | Test IDs | Acceptance |
|---|---|---|---|
| PATH-001 | Repository and package relative-path contract | 002-T11 | ACC-013 |
| PATH-002 | Codex-root-relative private layout | 002-T01 through 002-T05, 002-T12 | ACC-008 through ACC-010 |
| PATH-003 | PathAuthority and named anchors | 002-T01 through 002-T05, 002-T12 | ACC-008 through ACC-010 |
| SEC-001 | Public-tree secret prohibition | 002-T09, 002-T11 | ACC-011, ACC-013 |
| SEC-002 | Private environment loading and rotation | 002-T07 through 002-T10 | ACC-001, ACC-011, ACC-012 |
| SEC-003 | Central redaction and safe diagnostics | 002-T09, 002-T11 | ACC-011, ACC-018 |

ACC-018 redaction authority is split intentionally: 002 owns secrets, private IDs, machine paths, and emission safety; 003 owns evidence minimization; 005 owns allowed recommendation and message fields.

## 20. Implementation checklist

- [ ] Implement PathAuthority as the only runtime path constructor.
- [ ] Implement exact root precedence and named paths.
- [ ] Implement link-aware containment and stored-relative validation.
- [ ] Implement config schema version 1 and atomic writes.
- [ ] Implement the non-executing .env parser.
- [ ] Implement SecretHandle and centralized redaction.
- [ ] Implement effective permission checks.
- [ ] Implement rotation and safe reload handoff.
- [ ] Add public placeholder example and documentation.
- [ ] Add all tests and objective evidence in sections 16 and 17.
- [ ] Obtain approval before governed product code is written.
