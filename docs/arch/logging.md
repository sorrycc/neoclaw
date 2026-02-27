# Logging

All logging MUST go through the `logger` from `src/logger.ts`. Never use `console.log`/`console.error` directly for operational logs.

## Log Levels

- **error**: Failures that need attention — unhandled exceptions, I/O failures, API errors. Always include the error object and enough context to identify what failed (IDs, keys, paths).
- **warn**: Recoverable problems — fallback paths taken, corrupt data skipped, parse failures with recovery. Log what went wrong and what fallback was used.
- **info**: Lifecycle events and operational data — service start/stop, config reload, job fired/added/removed, token usage, consolidation results. Things you'd want in production logs.
- **debug**: Request-level tracing — inbound messages, tool calls, session operations. High volume, only useful during development.

## Rules

1. Every log call must include a **tag** (first arg) matching the module: `"agent"`, `"telegram"`, `"cron"`, `"session"`, `"memory"`, `"consolidation"`, `"subagent"`, `"heartbeat"`, `"config"`, `"dispatch"`, `"neoclaw"`, `"cli"`.
2. Include **identifiers** in logs — session keys, job IDs, chat IDs, file IDs. A log without context is noise.
3. Do NOT log bare function names like `logger.debug("memory", "readMemory")`. If there's nothing useful to say, don't log.
4. **Truncate** user content in logs (`.slice(0, 100)`) to avoid leaking sensitive data and bloating output.
5. Never silently swallow errors in catch blocks. At minimum log a `warn` when falling back, `error` when giving up.
6. State-changing operations (file rotation, job add/remove/pause/resume, config reload, consolidation) are `info`, not `debug`.
7. Log format is: `ISO_TIMESTAMP [LEVEL] [tag] message`. This is handled by `logger.ts` — do not manually format timestamps.
