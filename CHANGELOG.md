# Changelog

## 2026-03-07

### Added
- Web admin console v1 with dedicated `Dashboard`, `Chat`, `Config`, `Cron`, and `Skills` pages.
- Persistent Web Chat sessions backed by `SessionManager` with create/list/detail/clear/delete support.
- Cron management over Web: list, create, pause, resume, and delete.
- Skills management over Web: local skill list/detail/delete plus `clawhub` market health, search, and install.
- Dashboard summaries for runtime status, config snapshots, cron jobs, installed skills, and recent errors.
- Focused test coverage for `SkillManager`, Web helpers, real Web API routes, and Cron behavior.

### Changed
- Wizard is now a dedicated onboarding page instead of acting as the long-term admin surface.
- Web `Start Agent` now launches the main agent in the background so the admin console remains available.
- Config page now shows unsaved-change hints and save counts.
- Chat page now supports session search and message copy.
- Skills market automatically falls back to `npx clawhub@latest` when local `clawhub` is unavailable.

### Fixed
- Removed CSP-blocked external font import from the Web UI.
- Added inline favicon to avoid `favicon.ico` 404 noise in browser checks.

### Notes
- `clawhub` market install is handled by fixed structured commands only; the UI never accepts arbitrary shell command input.
- In anonymous environments, `clawhub install` may still fail due to remote rate limits; the UI now surfaces those logs directly.
