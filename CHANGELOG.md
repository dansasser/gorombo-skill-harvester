# Changelog

Notable user-visible changes to Gorombo Skill Harvester are recorded here.

## 0.1.4 - 2026-08-18

### Changed
- Make "extend-existing" harvested findings actionable. They now produce a recommendation and are delivered to enabled routes rather than being silently recorded. The existing skill is not automatically modified.
- Include the existing skill name and extension context in the delivered alert.

## 0.1.3 - 2026-08-17

### Added

- A linked DeepWiki badge for the public repository documentation.

### Changed

- Installation and getting-started instructions now use the published npm package.

## 0.1.2 - 2026-08-17

### Added

- Durable skill recommendations generated from completed Codex goals.
- Telegram alerts, private pairing, authorized text tasks, status, and cancellation.
- Delivery to one selected Codex task by its visible name.
- Combined route mode with independent delivery state and receipts.
- Event-driven completion handoff, restart recovery, and always-on user services.
- Generic external Harvester alert intake with stable-key deduplication.
- Source-package, packed-installation, privacy, and deterministic runtime verification.

### Security

- Private configuration is stored outside the repository beneath the runtime-discovered Codex root.
- Public status, diagnostics, recommendations, and package contents exclude credentials and private identities.
