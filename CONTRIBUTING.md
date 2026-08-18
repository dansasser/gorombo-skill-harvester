# Contributing to Gorombo Skill Harvester

Gorombo Skill Harvester accepts bug reports, feature requests, documentation improvements, and focused code contributions. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Open an issue

Search existing issues before creating a new one. Use one issue for one problem.

A useful bug report includes:

- the Gorombo Skill Harvester version or commit;
- the operating system and installation method;
- the selected route mode;
- clear reproduction steps;
- expected and actual behavior;
- minimal logs or error output with secrets and private data removed.

A feature request should describe the user problem, the affected workflow, and the observable outcome the change should provide.

Do not report vulnerabilities, credentials, private data, or other sensitive information in a public issue. Follow the [Security Policy](SECURITY.md). Use [Support](SUPPORT.md) for setup and usage questions.

## Prepare a contributor checkout

Requirements:

- Node.js 22.13.0 or newer.
- An authenticated stable Codex CLI 0.147.0 or newer for runtime integration checks.

Install and verify the checkout:

```sh
npm install
npm run check
npm test
npm run verify
```

Most deterministic tests use fixtures and do not require Telegram credentials. Keep any private runtime configuration outside the repository.

## Preserve the product boundaries

Changes must preserve these public contracts:

- repository-owned paths remain relative to the repository, plugin, or skill root;
- runtime state is resolved from `<CODEX_HOME>` and stored beneath `.gorombo/`;
- no reusable file hardcodes a machine path, hostname, credential, private identity, or pairing state;
- completion handling remains event-driven rather than periodically polling for finished work;
- a recommendation is durable before its alert is queued;
- user alerts contain readable recommendation details rather than raw assessment JSON;
- Telegram, selected Codex task, and combined route receipts remain independent;
- status and diagnostics remain bounded and redacted.

Read the [documentation hub](docs/README.md) and the applicable specification before changing runtime behavior.

## Make a focused change

Create a branch from `main` and keep each contribution limited to one coherent problem. Avoid unrelated refactors and generated-file churn.

Add or update tests for changed behavior. Update the README and public guides when a change affects installation, configuration, commands, security, or user-visible behavior. Add a [Changelog](CHANGELOG.md) entry for user-visible changes.

Do not commit:

- `.env` files, API keys, bot tokens, credentials, or private data;
- `.gorombo/`, runtime databases, pairings, task records, recommendations, logs, or receipts;
- package tarballs, coverage output, or generated service definitions;
- machine-specific paths, hostnames, editor files, or unrelated generated artifacts.

## Submit a pull request

Before submitting:

- confirm the change is focused;
- link the relevant issue when one exists;
- update tests and documentation;
- run and report the required verification;
- review the complete diff for secrets and private runtime material.

The pull-request description should explain:

- the problem being solved;
- the implementation and important decisions;
- user-visible or compatibility impact;
- tests and checks run;
- known limitations or unverified behavior.

Passing checks does not guarantee acceptance. Maintainers may request changes to behavior, scope, tests, documentation, security, or compatibility.

## Project policies

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)

Contributions accepted into this repository are provided under the project's MIT license.
