---
name: gorombo-skill-harvester
description: Use when Codex should turn completed work into a durable reusable-skill recommendation, configure or operate Telegram alerts and tasks, deliver alerts to a selected Codex task, inspect Gorombo Skill Harvester readiness, or recover its delivery queue.
---

# Gorombo Skill Harvester

Run the readiness check before harvesting, delivery, or Telegram task operations. Resolve this skill directory at runtime and invoke the package CLI relative to it:

    node ../../src/cli.js status --json

If status reports `NEEDS_ONBOARDING`, follow [onboarding.md](references/onboarding.md). Do not ask for a bot token in chat or pass one on the command line. The user places it in the private environment file documented by onboarding.

For a completed task, submit only bounded, sanitized evidence. Gorombo Skill Harvester owns the durable assessment, Markdown recommendation, direct outbox enqueue, and enabled-route delivery. Do not send raw assessment JSON as the alert.

Use [operations.md](references/operations.md) for pairing, route tests, Telegram tasks, selected-task delivery, service lifecycle, and recovery.
