# Neoclaw

Multi-channel AI agent with CLI and Telegram support.

## Architecture

See `docs/arch/` for detailed design docs:

- [Agent System](docs/arch/agent.md) — orchestrator, modules, message flow
- [Logging](docs/arch/logging.md) — log levels, tags, and rules
- [Memory System](docs/arch/memory-system.md) — memory storage and consolidation
- [Channel System](docs/arch/channels.md) — channels, message bus, I/O boundary
- [Cron System](docs/arch/cron-system.md) — scheduled job management

## Development

- Use `bun` as the package manager. Do not use `npm` to install dependencies.
