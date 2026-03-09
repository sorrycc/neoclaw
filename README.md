# neoclaw

[![](https://img.shields.io/npm/v/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/dm/neoclaw)](https://www.npmjs.com/package/neoclaw)
[![](https://img.shields.io/npm/l/neoclaw)](https://www.npmjs.com/package/neoclaw)

A multi-channel AI agent built with [Neovate Code](https://github.com/neovate-code/neovate-code).

## Features

- **Multi-channel** — CLI, Telegram, DingTalk, Feishu (experimental), and QQ (experimental)
- **AI-powered** — Neovate Code agent with configurable models and providers
- **Memory** — persistent conversation memory with automatic consolidation
- **Cron jobs** — scheduled tasks with cron expression support
- **Profiles** — multiple isolated configurations via `--profile`
- **Hot reload** — config changes apply without restart
- **Heartbeat** — built-in health monitoring
- **Web admin console** — Dashboard, Chat, Config, Cron, and Skills management

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

# Start the agent only (does NOT open the Web UI)
neoclaw

# Or open the Web admin console when you want Dashboard / config UI
neoclaw web --host 127.0.0.1 --port 8788
```

If running from source, you can choose whether to open the Web UI:

```bash
# Start the agent only (does NOT open the Web UI)
bun run start

# Open the Web admin console from source
bun run start web --host 127.0.0.1 --port 8788
```

In other words, the Web page is **optional**:

- `neoclaw` / `bun run start` → start the agent only
- `neoclaw web` / `bun run start web` → open the Web admin console
- `neoclaw onboard --mode web` → start from onboarding in the Web UI

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

# from source
bun run start web --dev --host 127.0.0.1 --port 8788

# or start from onboarding flow
neoclaw onboard --mode web
```

Note: `neoclaw` and `bun run start` do **not** open the Web page by default. Use the `web` command only when you want the Dashboard / config UI.

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


## Web Admin Console

The Web console now includes:

- `Dashboard` — runtime, config, cron, skill, and error summaries
- `Chat` — persistent Web Chat with session management
- `Config` — the single configuration center
- `Cron` — create/pause/resume/delete scheduled jobs
- `Skills` — local skill management plus `clawhub` market search/install

Useful docs:

- `CHANGELOG.md`
- `docs/2026-03-07-web-admin-console-validation.md`
- `docs/designs/2026-03-07-web-admin-console-v1-design.md`

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

QQ (experimental) minimal config:

```json
{
  "channels": {
    "qq": {
      "enabled": true,
      "appId": "your-app-id",
      "clientSecret": "your-client-secret",
      "allowFrom": [],
      "requireMention": true,
      "apiBase": "https://api.sgroup.qq.com",
      "wsIntentMask": 1107297280,
      "wsReconnectBaseMs": 1000,
      "wsReconnectMaxMs": 30000,
      "dedupPersist": false,
      "dedupFile": "~/.neoclaw/qq-dedup.json"
    }
  }
}
```

QQ notes:

- This integration targets the official QQ Open Platform Bot API.
- The first stable path is usually sandbox private chat; group/channel permissions may require extra platform approval.
- Leave `wsIntentMask` at the default unless you know exactly which event scopes you need to change.
- For group use, keeping `requireMention` enabled is recommended.


## Development

Requires [Bun](https://bun.sh). Do not use npm to install dependencies.

```bash
bun install          # Install dependencies
bun dev              # Watch mode
bun start            # Run agent from source (no Web page)
bun run start web    # Open Web admin console from source
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
