# SDD 011: Plugin packaging and installation

## 1. Status and package boundary

- Status: implementation baseline
- Version: 1
- Product name: Gorombo Skill Harvester
- Package name: @gorombo/gorombo-skill-harvester
- License: MIT

The repository root is the plugin root. Tracked package references are relative to the repository or skill directory as appropriate. Runtime absolute paths may be resolved from the environment, user input, Codex root, package root, or service manager and are never persisted in reusable source artifacts.

The npm package includes:

~~~text
.codex-plugin/plugin.json
skills/gorombo-skill-harvester/
hooks/
migrations/
scripts/
src/
test/
docs/
.env.example
LICENSE
README.md
SECURITY.md
package.json
~~~

The Git repository also contains package-lock.json. npm intentionally omits package-lock.json from the tarball; test/ is public package content so the installed artifact can run the complete deterministic suite.

The package excludes .env, .gorombo, node_modules, databases, logs, recommendations, pairing/task/session records, generated service definitions, release evidence, credentials, private identifiers, and machine paths.

## 2. Runtime baseline

The package uses ESM JavaScript and Node 22.13 or newer with the built-in node:sqlite API. It has no runtime npm dependencies and does not require native compilation. An authenticated stable Codex CLI 0.147.0 or newer is part of the runtime baseline. A global npm install is optional for the Gorombo Skill Harvester CLI; the plugin itself runs its package-owned relative CLI.

preflight checks the Node version, node:sqlite import, required SQLite pragmas, crypto, fetch, AbortController, child_process, and filesystem operations. It then uses bounded read-only probes to discover the highest compatible stable Codex launcher, verify the minimum version, verify `codex login status`, and verify `codex app-server --help`. The same private in-memory launch plan is reused by the App Server, Telegram tasks, and recommendation assessment. Public output contains safe categories and versions only; it omits the resolved launcher path, authentication mode, and probe stdout/stderr. The App Server help probe proves command availability, not a full protocol handshake. Failure occurs before onboarding creates private state.

The relative executable entry is src/cli.js. The skill resolves its own directory and invokes ../../src/cli.js. No installed destination is embedded.

## 3. Plugin and skill contracts

.codex-plugin/plugin.json, package.json, SKILL.md, and agents/openai.yaml agree on name and description. The plugin points to ./skills/. SKILL.md frontmatter contains only name and description. Every linked reference exists in the packed artifact.

The plugin installs immutable public files only. Installation does not start a service, create .gorombo, create a database, or create a real .env.

status --json is read-only and reports NEEDS_ONBOARDING when private state is absent.

The repository root is the plugin root. Codex's plugin-creator flow can wire that root into a local marketplace for authoring and testing. Publishing to the universal plugin directory is a separate release action and is not implied by npm installation.

## 4. Onboarding

onboard is the first operation allowed to create private state under the runtime-discovered Codex root:

~~~text
<CODEX_HOME>/.gorombo/.env
<CODEX_HOME>/.gorombo/gorombo-skill-harvester/
~~~

Gorombo Skill Harvester creates the product directories, config, database, private completion-handoff directory, recommendations directory, runtime directory, logs, backups, and recovery directory. It does not create the real .env. It displays the documented path and required variable names so the user can create the private file.

Onboarding selects telegram, session, or both; configures the chosen session name; validates Telegram configuration without echoing it; performs route tests; and offers service installation. READY requires storage and every selected route test.

## 5. Update and rollback

Package updates replace immutable public files independently of private state. Version 0.1.0 has one schema and no schema-changing update command. Re-running the same package is idempotent, and an older package refuses a newer schema without mutation.

A future schema-changing release must implement and verify the SDD 004 backup, migration, restore, and rollback boundary before updating private state.

## 6. Uninstall

Plugin or service uninstall removes only the public installation or generated service definition. It preserves the private .env, recommendations, database, outbox, bindings, tasks, and reserved backup directory.

Version 0.1.0 exposes no private-data deletion command. Removing private state requires a separately reviewed explicit local procedure while the service is stopped.

## 7. Public validation

Before packaging:

- plugin and skill validators pass;
- all package and skill references resolve beneath the package root;
- npm pack --dry-run --json matches the declared inventory;
- the packed artifact installs and runs its complete deterministic suite, preflight, and read-only status;
- the checkout test suite exercises the packed-install verifier with a one-level self-recursion guard;
- a clean install creates no private state;
- a fresh isolated onboarding creates only the planned private paths;
- update and uninstall fixtures preserve private data;
- scans find no secret, private identity, database, generated state, or machine-specific path.

## 8. Documentation

README and skill references document installation, private .env placement, onboarding, pairing, route selection, selected-session naming, Telegram tasks, status, service lifecycle, retries, dead letters, recovery, update, uninstall, and security reporting. Examples contain placeholders only.

## 9. Tests and acceptance

Acceptance uses both the checkout and the packed tarball. It verifies exact inventory, identical source and packed test inventories, the complete suite from the installed artifact, relative references, runtime preflight with a deterministic fake Codex CLI, clean status, isolated onboarding, route fake tests, service descriptor generation, update preservation, uninstall preservation, validator output, and public-tree/history secret scans. Controlled real Telegram, selected Codex task, and service-lifecycle receipts remain required for public release.

## 10. Version-1 decisions

- Public identity is @gorombo/gorombo-skill-harvester version 0.1.0.
- License is MIT.
- Runtime dependencies are limited to Node built-ins.
- Installation and onboarding are separate.
- Removing the plugin never removes private state.
