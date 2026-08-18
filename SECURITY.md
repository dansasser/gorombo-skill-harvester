# Security Policy

Gorombo Skill Harvester coordinates Codex execution, Telegram messages, credentials, private task text, recommendations, and durable local state. Security reports must be handled privately so users have time to protect their systems before details are made public.

## Supported versions

| Version | Security support |
| --- | --- |
| Current 0.1.x | Supported |
| Earlier development snapshots | Not supported |

Reproduce a report against the latest available 0.1.x source when possible.

## Report a vulnerability

Email [contact@gorombo.com](mailto:contact@gorombo.com) with a subject beginning `[Gorombo Skill Harvester Security]`.

Do not disclose the issue in a public issue, pull request, discussion, log, screenshot, or other public channel. Do not include working credentials, private user data, task text, recommendations, databases, or access tokens unless the maintainers provide a secure transfer method.

Include:

- the affected version or commit;
- the installation method and operating system;
- the affected component or route;
- clear reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- likely impact and attack conditions;
- any known mitigation or workaround;
- your preferred attribution, or a request to remain anonymous.

## What happens next

The maintainers will:

1. acknowledge and review the report;
2. reproduce and assess the affected release and impact;
3. coordinate questions, remediation, and disclosure with the reporter;
4. prepare a fix or mitigation for supported versions;
5. publish an advisory or release note when disclosure is appropriate.

Response and remediation time depend on severity, reproducibility, dependencies, and release complexity. This policy does not promise a fixed service-level agreement.

## Secret boundary

Real secrets belong only in `<CODEX_HOME>/.gorombo/.env`. The plugin, skill directory, Git repository, npm package, command arguments, status output, alerts, and generated service definition must not contain them.

Gorombo Skill Harvester reads the private environment file as data. It rejects symlinks, oversized files, duplicate names, shell-expansion syntax, and malformed values. It never creates the real `.env`.

Private configuration, SQLite state, recommendations, pairings, task records, route bindings, delivery attempts, and receipts are stored beneath `<CODEX_HOME>/.gorombo/gorombo-skill-harvester/`. Reusable files refer to that layout through runtime-discovered roots rather than machine-specific paths.

## Telegram and task execution

Only explicitly allowed Telegram users can pair. Pairing requires a short-lived code delivered by the bot and local approval. Authorization, active binding, route readiness, task working directory, and sandbox are rechecked before task launch.

The default task sandbox is `read-only`. `workspace-write` and `danger-full-access` increase authority and should be selected only when the operator intends that access.

Telegram's `sendMessage` method has no provider idempotency key. A crash after provider acceptance but before the local receipt commits can make acceptance ambiguous; a later retry may duplicate the message. Gorombo Skill Harvester preserves that uncertainty instead of claiming exactly-once delivery.

## Safe diagnostics

Public status and error surfaces use bounded reason codes and counts. They must not emit credentials, private identities, internal Codex task IDs, task bodies, recommendation bodies, provider responses, raw exceptions, or absolute paths.

Run `npm run verify` before publishing a package.

## Research expectations

Use good-faith methods that avoid privacy violations, data destruction, service disruption, social engineering, credential theft, persistence, or access beyond what is necessary to demonstrate the issue. Stop testing and report the issue if you encounter private data or gain unintended access.

For non-security bugs, installation help, and usage questions, use [Support](SUPPORT.md).
