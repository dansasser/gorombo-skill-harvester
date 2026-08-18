# Gorombo Skill Harvester planning package

## Status

This directory is the historical design record for the implemented Gorombo Skill Harvester package. The implementation plan and project expectations remain useful for intent and traceability, while docs/specs and the tested source tree define current behavior.

Planning language that describes a future product should be read as the design baseline at the time it was written, not as a claim that product code is still absent.

## Document map

1. implementation-plan.md defines the integrated product architecture, flows, phases, and exit criteria.
2. project-expectations.md separates confirmed expectations from implementation choices and defines product-level acceptance.
3. expected-files.md records the current public package and private runtime layout.
4. decision-register.md records decisions, completed planning gates, and later work.
5. spec-roadmap.md defines the SDD sequence that was used to create docs/specs.
6. acceptance-matrix.md maps success, failure, restart, and recovery scenarios to evidence.

## Current authority

- Tested source and packaged artifacts are the implementation evidence.
- docs/specs defines the current behavioral contracts.
- docs/planning records why those contracts were chosen.
- When a historical planning statement conflicts with implemented behavior, the applicable SDD and verified code control.

## Source guidance

The design uses these public interfaces:

- OpenAI Codex App Server: https://learn.chatgpt.com/docs/app-server
- OpenAI plugin skill guidance: https://developers.openai.com/plugins/build/skills
- OpenAI plugin packaging guidance: https://developers.openai.com/plugins/build/plugins
- Telegram Bot API: https://core.telegram.org/bots/api

The public package contains no private credentials or machine-specific installation path.
