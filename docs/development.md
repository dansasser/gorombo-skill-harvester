# Development

## Repository layout

```text
.codex-plugin/                 Plugin manifest
hooks/                         Codex completion hook
skills/gorombo-skill-harvester/           Skill instructions and agent-facing references
src/                           CLI and runtime implementation
migrations/                    SQLite migrations
docs/                          Public guides and design records
scripts/                       Validation and release checks
test/                          Deterministic tests
```

Keep user-facing documentation at the repository root or in `docs/`. Keep `skills/gorombo-skill-harvester/SKILL.md` concise and place only agent-facing operational references beneath the skill.

## Install dependencies

```sh
npm install
```

The package has no runtime dependencies. Node.js built-ins and the discovered Codex runtime provide the implementation boundary.

## Run checks

```sh
npm run check
npm test
npm run verify
npm pack --dry-run --json
```

- `npm run check` validates syntax, skill structure, package contents, and public-file privacy rules without running the test suite.
- `npm test` runs deterministic source tests.
- `npm run verify` runs all checks and tests, creates an actual tarball, installs it in isolation, verifies its shipped tests, and checks isolated onboarding.
- `npm pack --dry-run --json` shows the exact public package inventory.

Do not claim a command passed unless it was run successfully. Report any skipped platform-specific test.

## Public package boundary

The npm package includes the plugin, skill, hook, runtime, migrations, deterministic tests, public guides, and policy documents. It excludes private runtime state, package tarballs, repository-only planning records, and detailed design specifications.

Public artifacts must not contain:

- real `.env` files, credentials, tokens, or authorization headers;
- real user, chat, task, pairing, or provider identities;
- household or machine names, private network addresses, or connection topology;
- absolute developer or deployment paths;
- databases, recommendations, logs, receipts, locks, service definitions, or backups;
- private deployment history or controlled-installation evidence.

Generic placeholders such as `<CODEX_HOME>`, environment-variable names, and example IDs explicitly identified as placeholders are allowed.

## Documentation standards

- Keep the README focused on understanding, installing, onboarding, and using the product.
- Put detailed public configuration and operational guidance in `docs/`.
- Keep planning and specifications separate from user instructions.
- Use repository-relative links and verify that every linked packaged file ships.
- Use truthful static badges until a public registry, release, or CI destination exists.
- Never document a private host arrangement as a product feature.

## Release checklist

1. Update user-facing documentation and the changelog.
2. Run the complete verification sequence.
3. Inspect the dry-run package inventory.
4. Scan source and packed output for private material.
5. Confirm every README command exists in the CLI.
6. Confirm every relative Markdown link resolves.
7. Review the packed README, license, security policy, support guide, and contributor documents.
