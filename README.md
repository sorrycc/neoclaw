# neoclaw

[![](https://img.shields.io/npm/v/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/dm/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/l/neoclaw)](https://www.npmjs.com/package/neoclaw)

A multi-channel AI agent built with [Neovate Code](https://github.com/neovate-code/neovate-code).

## Features

- **Multi-channel** — CLI, Telegram, and DingTalk
- **AI-powered** — Neovate Code agent with configurable models and providers
- **Memory** — persistent conversation memory with automatic consolidation
- **Cron jobs** — scheduled tasks with cron expression support
- **Profiles** — multiple isolated configurations via `--profile`
- **Hot reload** — config changes apply without restart
- **Heartbeat** — built-in health monitoring

## Install

```bash
npm install -g neoclaw
```

## Quick Start

```bash
# Initialize and launch Web setup wizard (recommended for first-time setup)
neoclaw onboard --mode web

# Or create/refresh default config file directly
neoclaw onboard

# Start the agent
neoclaw
```

## CLI Usage

```
neoclaw [command] [options]

Commands:
  (default)    Start the agent
  onboard      Initialize workspace and configuration
  status       Show agent status and cron jobs
  cron         Manage scheduled tasks
  web          Start web configuration UI
  help         Show help

Options:
  --profile <name>  Use a named profile (~/.neoclaw-<name>)
  --dev             Use dev profile (~/.neoclaw-dev)
  --mode <mode>     Onboard mode (for onboard command): default|web
  --host <host>     Web UI bind host (for web / onboard --mode web)
  --port <port>     Web UI bind port (for web / onboard --mode web)
  --token <token>   Web UI auth token (for web / onboard --mode web)
  -y, --yes         Auto-confirm prompts (for onboard command)
  -v, --version     Print version
  -h, --help        Show help
```

## Web Configuration UI

```bash
# start config UI directly on localhost:3180 (prints auth token in log)
neoclaw web

# or start from onboarding flow
neoclaw onboard --mode web
```

Then open `http://127.0.0.1:3180` and set request header:

- Preferred: enter token on the login page
- Optional API mode: `Authorization: Bearer <token>`

## Configuration

Config lives at `~/.neoclaw/config.json` (or `~/.neoclaw-<profile>/config.json`).

## Development

Requires [Bun](https://bun.sh). Do not use npm to install dependencies.

```bash
bun install          # Install dependencies
bun dev              # Watch mode
bun start            # Run from source
bun run typecheck    # Type check
bun run build        # Build for distribution
```

## License

MIT
