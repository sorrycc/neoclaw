# Neoclaw — Modular Core Design

**Date:** 2026-02-15

## Context

Neoclaw is a TypeScript rewrite of [nanobot](https://github.com/nanobot-ai), a lightweight personal AI assistant framework originally written in Python. Nanobot is an event-driven application that connects chat platforms (Telegram, Discord, etc.) to LLM providers via an async message bus, giving the LLM tools and persistent memory.

The goal is to rewrite the core architecture in TypeScript, run it on Bun, and use `@neovate/code` as the LLM loop instead of implementing custom LLM provider/tool-calling logic. The nanobot analysis document (`nanobot-analysis.md`) served as the reference for all subsystems and patterns.

## Discussion

### Scope

All major subsystems from nanobot were deemed in-scope for the basic version:

- **Channels:** Telegram (long-polling) + CLI (stdin/stdout)
- **Core architecture:** MessageBus, BaseChannel abstraction, Agent interface
- **Session management:** JSONL sessions keyed by `channel:chatId`, in-memory cache
- **Memory system:** Two-layer (MEMORY.md facts + HISTORY.md log) with LLM consolidation
- **Background services:** Cron (timer-based scheduling), Heartbeat (periodic wake), Subagents (isolated sessions)

### Tool Strategy

Since `@neovate/code` already provides built-in tools (file I/O, shell, web search, etc.), no custom ToolRegistry is needed. Neovate's tools are used as-is.

### LLM Integration

Streaming sessions via `createSession()` — one `SDKSession` per chat, kept alive across messages. Messages are sent via `session.send()` and results consumed via `session.receive()` async iterator.

### Approaches Evaluated

| Approach | Description | LOC Estimate | Verdict |
|----------|-------------|--------------|---------|
| **A: Thin Wrapper** | Neovate IS the agent. Neoclaw only routes messages + manages memory/cron. | ~800-1200 | Simplest, but limited flexibility |
| **B: Hybrid** | Full port of nanobot architecture, Neovate used only as LLM call mechanism. | ~2000-3000 | Most control, but redundant with Neovate |
| **C: Modular Core** | Clean interfaces with Neovate adapter. Swappable implementations. | ~1200-1800 | **Selected** — balance of structure and simplicity |

Approach C was selected for its balance: clean separation of concerns via interfaces, without over-engineering or duplicating what Neovate already provides.

## Approach

Define clean TypeScript interfaces for each subsystem (Channel, Bus, Agent, Memory, Scheduler). The Agent implementation delegates LLM work to `@neovate/code` streaming sessions. All modules communicate exclusively through the MessageBus (two async queues). No module reaches across boundaries except through interfaces, making it straightforward to swap implementations later.

Context (personality, memory, identity) is injected into Neovate via the `skills` option — workspace markdown files (AGENTS.md, SOUL.md, USER.md, MEMORY.md) are passed as skill paths to `createSession()`.

## Architecture

### Project Structure

```
neoclaw/
├── src/
│   ├── index.ts              # Entry point, bootstrap
│   ├── config/
│   │   └── schema.ts         # Config types + loader (JSON, env vars)
│   ├── bus/
│   │   ├── types.ts          # InboundMessage, OutboundMessage
│   │   └── message-bus.ts    # Dual async queue (inbound/outbound)
│   ├── channels/
│   │   ├── channel.ts        # Channel interface
│   │   ├── manager.ts        # ChannelManager: start/stop/dispatch
│   │   ├── telegram.ts       # TelegramChannel (grammy)
│   │   └── cli.ts            # CLIChannel (readline/stdin)
│   ├── agent/
│   │   ├── agent.ts          # Agent interface
│   │   ├── neovate-agent.ts  # Neovate SDK implementation
│   │   └── context.ts        # System prompt assembly (skills, memory, identity)
│   ├── session/
│   │   └── manager.ts        # JSONL session store, in-memory cache
│   ├── memory/
│   │   └── memory.ts         # MEMORY.md + HISTORY.md, consolidation
│   └── services/
│       ├── cron.ts           # CronService (timer-based scheduling)
│       ├── heartbeat.ts      # HeartbeatService (periodic wake)
│       └── subagent.ts       # SubagentManager (isolated Neovate sessions)
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### Core Interfaces

```typescript
interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  media: string[];
  metadata: Record<string, unknown>;
  sessionKey: string;     // `${channel}:${chatId}`
}

interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media: string[];
  metadata: Record<string, unknown>;
}

interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
}

interface Agent {
  processMessage(msg: InboundMessage): Promise<OutboundMessage | null>;
}
```

### Data Flow

1. Channel receives user input, creates `InboundMessage`, calls `bus.publishInbound(msg)`
2. Main loop blocks on `bus.consumeInbound()`, calls `agent.processMessage(msg)`
3. Agent loads/creates session, builds context, sends to Neovate `SDKSession` via `session.send()`
4. Agent streams `session.receive()`, collects final result, saves session
5. Main loop calls `bus.publishOutbound(response)`
6. ChannelManager dispatch loop consumes outbound queue, routes to `channel.send()` by `msg.channel`

### Neovate Agent Integration

- One `SDKSession` per `sessionKey` (per chat), kept alive in a `Map<string, SDKSession>`
- Context files (AGENTS.md, SOUL.md, USER.md, MEMORY.md) passed as `skills` to `createSession()`
- On `/new` command: close existing session, archive, create fresh one
- Memory consolidation: when message count exceeds `memoryWindow` (default 50), a separate `prompt()` call summarizes old messages, writes updated MEMORY.md + appends to HISTORY.md, then recreates the SDKSession with updated skills

### Channels

- **CLIChannel:** readline-based stdin loop. `send()` writes to stdout. No auth.
- **TelegramChannel:** `grammy` library (lightweight, Bun-compatible). Long-polling. Typing indicator via `sendChatAction("typing")` every 4s. Markdown-to-Telegram-HTML conversion. `allowFrom` access control.
- **ChannelManager:** `Map<string, Channel>`. `startAll()` launches all channels + outbound dispatch loop via `Promise.all()`.

### Background Services

- **CronService:** Jobs stored in `~/.neoclaw/data/cron/jobs.json`. Schedule types: `"at"` (one-shot), `"every"` (interval), `"cron"` (cron expression via `cron-parser`). Uses `setTimeout` to arm next wake. Fires synthetic `InboundMessage` with `channel: "system"`.
- **HeartbeatService:** Sleeps `intervalMs` (default 30 min), reads `HEARTBEAT.md`, injects synthetic inbound message if non-empty.
- **SubagentManager:** Spawns isolated Neovate sessions via `createSession()` with focused prompts. Runs as background promises. Results published back as system `InboundMessage`.

### Configuration

```typescript
interface Config {
  agent: {
    model: string;
    temperature: number;
    maxTokens: number;
    memoryWindow: number;
    workspace: string;
  };
  channels: {
    telegram: { enabled: boolean; token: string; allowFrom: string[]; proxy?: string };
    cli: { enabled: boolean };
  };
  providers?: Record<string, ProviderConfig>;
}
```

- Loaded from `~/.neoclaw/config.json` (camelCase on disk)
- Env var override via `NEOCLAW_` prefix
- Fail fast on validation errors at startup

### Error Handling

- **Channel errors:** Log + retry with exponential backoff, don't crash
- **Agent/Neovate errors:** Catch per-message, send error summary to user, continue loop
- **Config errors:** Fail fast at startup with actionable message
- **Session file corruption:** Log warning, start fresh session

### Workspace Layout

```
~/.neoclaw/
├── config.json
├── workspace/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── USER.md
│   ├── IDENTITY.md
│   ├── HEARTBEAT.md
│   ├── skills/{name}/SKILL.md
│   └── memory/
│       ├── MEMORY.md
│       └── HISTORY.md
├── sessions/{key}.jsonl
└── data/cron/jobs.json
```

### Bootstrap

```typescript
const config = loadConfig();
const bus = new MessageBus();
const sessionManager = new SessionManager(config.agent.workspace);
const contextBuilder = new ContextBuilder(config.agent.workspace);
const agent = new NeovateAgent(config, bus, sessionManager, contextBuilder);
const channelManager = new ChannelManager(config, bus);
const cron = new CronService(config, bus);
const heartbeat = new HeartbeatService(config, bus);

await Promise.all([
  mainLoop(bus, agent),
  channelManager.startAll(),
  cron.start(),
  heartbeat.start(),
]);
```
