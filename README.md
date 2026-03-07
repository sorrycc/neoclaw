# neoclaw

[![](https://img.shields.io/npm/v/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/dm/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/l/neoclaw)](https://www.npmjs.com/package/neoclaw)

A multi-channel AI agent built with [Neovate Code](https://github.com/neovate-code/neovate-code).

## Features

- **Multi-channel** — CLI, Telegram, DingTalk, and Feishu (experimental)
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
# Initialize workspace and config
neoclaw onboard

# Or start from onboarding flow and open web panel directly
neoclaw onboard --mode web

# In web onboarding mode, save config first,
# then click Start Agent in the UI.
# It will choose `neoclaw` or `bun run start` automatically.

# Edit config
# ~/.neoclaw/config.json

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
  web          Open web config panel
  help         Show help

Options:
  --profile <name>  Use a named profile (~/.neoclaw-<name>)
  --dev             Use dev profile (~/.neoclaw-dev)
  --mode <mode>     Onboard mode (for onboard command): default|web
  --host <host>     Bind host for web command (default: 127.0.0.1)
  --port <port>     Bind port for web command (default: 8788)
  --token <token>   Web auth token (for web / onboard --mode web)
  -y, --yes         Auto-confirm prompts (for onboard command)
  -v, --version     Print version
  -h, --help        Show help
```

Open web config panel:

```bash
neoclaw web --dev --host 127.0.0.1 --port 8788

# or start from onboarding flow
neoclaw onboard --mode web
```

If running from source, build frontend first:

```bash
bun run build:web
```

Web panel supports:
- Feishu config editing with validation feedback
- Secret masking (`appSecret` / `verificationToken` / `encryptKey`) on read
- Runtime read-only status (`/api/runtime-status`) with recent errors
- Config export/import (`/api/config/export`, `/api/config/import`)
- Auto snapshot before import + rollback from snapshots (`/api/config/snapshots`, `/api/config/rollback`)

## Configuration

Config lives at `~/.neoclaw/config.json` (or `~/.neoclaw-<profile>/config.json`).

Feishu (experimental) minimal config:

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "connectionMode": "webhook",
      "webhookHost": "127.0.0.1",
      "webhookPort": 3000,
      "webhookPath": "/feishu/events",
      "verificationToken": "",
      "allowFrom": [],
      "requireMention": true,
      "webhookMaxBodyBytes": 1048576,
      "webhookBodyTimeoutMs": 10000,
      "webhookRateLimitPerMin": 120,
      "wsReconnectBaseMs": 1000,
      "wsReconnectMaxMs": 30000,
      "dedupPersist": false,
      "dedupFile": "~/.neoclaw/feishu-dedup.json"
    }
  }
}
```

## Development

Requires [Bun](https://bun.sh). Do not use npm to install dependencies.

```bash
bun install          # Install dependencies
bun dev              # Watch mode
bun start            # Run from source
bun run typecheck    # Type check
bun run build        # Build for distribution
bun run build:web    # Build web assets to dist/web

# Web UI (React/Vite)
cd webapp
bun install
bun run dev          # Local UI dev
bun run build        # Build webapp/dist for `neoclaw web`
```

## License

MIT
