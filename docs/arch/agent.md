# Agent System

**Date:** 2026-02-27

## Overview

`NeovateAgent` is the central orchestrator that receives `InboundMessage`s from the message bus, delegates to an SDK session, and yields `OutboundMessage`s back. It coordinates session management, memory consolidation, skill resolution, media handling, and response streaming through focused collaborator modules.

## Module Map

```
src/agent/
  neovate-agent.ts    — orchestrator (~280 lines)
  skill-manager.ts    — skill discovery and command resolution
  media-queue.ts      — per-session outbound media accumulator
  media-resolver.ts   — inbound media classification + base64 encoding
  stream-processor.ts — async generator over SDK response stream
  context.ts          — system prompt assembly (identity, bootstrap, memory)
  tools/
    cron.ts           — cron job management tool
    send-file.ts      — file/image sending tool (writes to MediaQueue)
    code.ts           — code execution tool
```

## NeovateAgent Lifecycle

1. **Instantiation:** `NeovateAgent.create(config, cronService)` — async factory. Creates `SessionManager`, `MemoryManager` (both async I/O), then returns the agent.
2. **Message loop:** `processMessage(msg)` is an async generator called by `src/index.ts` for each inbound message. Yields progress and final messages.
3. **Config reload:** `updateConfig(config)` — closes all SDK sessions so they're re-created with new model/settings on next message.

## processMessage Flow

```
processMessage(msg)
  │
  ├─ handleCommand()         — /new, /stop, /help → yield reply, return
  │
  ├─ manageSessionWindow()   — if messages > memoryWindow:
  │     consolidate old messages, trim session, build recap,
  │     close stale SDK session
  │
  ├─ ensureMediaQueue()      — get-or-create MediaQueue for this session key
  │
  ├─ ensureSession()         — get-or-create SDK session with:
  │     system context, tools, skills, recap section
  │
  ├─ sendMessage()           — resolve skill command, resolve media,
  │     send to SDK session
  │
  ├─ processStream()         — iterate SDK response stream,
  │     yield progress messages, collect final content
  │
  └─ yield final             — append to session history, drain media queue,
       yield final OutboundMessage
```

## Module Responsibilities

### SkillManager (`skill-manager.ts`)

Consolidates all skill filesystem operations. Skills live in `{workspace}/skills/{name}/SKILL.md`.

- `getSkillNames()` — list valid skill directories (those containing `SKILL.md`)
- `getSkillPaths()` — return absolute paths to all `SKILL.md` files (passed to SDK `createSession`)
- `resolveSkillCommand(content)` — if content starts with `/`, look up matching skill, parse arguments (`$1`, `$ARGUMENTS`), return expanded prompt or `null`

All methods are async, using `fs/promises`.

### MediaQueue (`media-queue.ts`)

Simple accumulator for outbound media paths. Created per session key, passed into the `send_file` tool closure.

- `push(path)` — tool calls this when the agent wants to send a file
- `drain()` — returns and clears all accumulated paths (called after stream completes)
- `length` — getter for checking if any media is pending

### MediaResolver (`media-resolver.ts`)

Single async function `resolveMedia(mediaPaths, textContent)`. Handles inbound media attached to user messages.

- Classifies files by extension (`.jpg`, `.png`, `.gif`, `.webp` → image; rest → file)
- Builds a text part with labels (`[Image: path]`, `[File: path]`)
- Reads image files with `fs/promises.readFile`, base64-encodes them
- Returns `MessagePart[]` ready for `sdkSession.send()`

### StreamProcessor (`stream-processor.ts`)

Async generator function `processStream(session, replyFn)`. Iterates the SDK `session.receive()` stream and handles each message type:

| Message type | Action |
|---|---|
| `system` | Log session init info |
| `message` (assistant) | Yield text/reasoning as progress, log tool_use |
| `message` (tool/user) | Log tool_result status |
| `result` | Capture final content, log usage |

Returns the final content string via generator return value.

### ContextBuilder (`context.ts`)

Assembles the system prompt injected into SDK sessions.

- `getSystemContext(channel, chatId)` — async. Combines:
  - Identity block (runtime info, workspace paths, current time)
  - Bootstrap files (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`)
  - Long-term memory from `MemoryManager.readMemory()`
  - Current session info (channel, chatId)

## Session & Memory Integration

### SessionManager (`src/session/manager.ts`)

JSONL-based session persistence. One file per session key in `{baseDir}/sessions/`.

- `static create(sessionsDir)` — async factory, ensures directory exists
- `get(key)` / `append(key, role, content)` / `clear(key)` / `trimBefore(key, keepFrom)` / `messageCount(key)` — all async
- In-memory cache avoids re-reading files on every call
- `trimBefore` + `flush` rewrites the entire JSONL file (called during window management)

### MemoryManager (`src/memory/memory.ts`)

Manages long-term memory (`MEMORY.md`) and history logs (`HISTORY.md`, monthly rotated).

- `static create(workspace)` — async factory, ensures `{workspace}/memory/` exists
- `readMemory()` / `writeMemory(content)` — long-term memory CRUD
- `appendHistoryRotated(entry)` — writes to both `HISTORY.md` and `HISTORY-{YYYY-MM}.md`

### Consolidation Flow

When session messages exceed `config.agent.memoryWindow`:

1. Old messages (from `lastConsolidated` to cutoff) are sent to `ConsolidationService`
2. Consolidation produces a `historyEntry` (appended to history) and optionally a `memoryUpdate` (overwrites memory)
3. Session is trimmed to keep only recent messages
4. A recap of remaining messages is injected into the next SDK session's system prompt
5. The existing SDK session is closed so a fresh one picks up the recap

Consolidation has a configurable timeout (`consolidationTimeout`, default 30s). On failure, a raw fallback summary is written to history so nothing is lost.

## All I/O is Async

Every filesystem operation across the agent system uses `fs/promises`. No `readFileSync`, `writeFileSync`, `existsSync`, or `mkdirSync` calls remain in any agent module. This prevents blocking the event loop during message processing.

## Entry Points

| Layer | File | Notes |
|-------|------|-------|
| Orchestrator | `src/agent/neovate-agent.ts` | `NeovateAgent.create()`, `processMessage()`, `updateConfig()` |
| Main loop | `src/index.ts` | Instantiates agent, runs message loop, handles errors |
| Agent interface | `src/agent/agent.ts` | `Agent` interface with `processMessage()` |
| Bus types | `src/bus/types.ts` | `InboundMessage`, `OutboundMessage`, `sessionKey()` |
