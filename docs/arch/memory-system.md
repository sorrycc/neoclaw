# Memory System

**Date:** 2026-02-27

## Overview

Two-layer memory system that gives the agent persistent recall across sessions. Layer 1 (MEMORY.md) holds long-term facts loaded into every system prompt. Layer 2 (HISTORY.md) is an append-only event log searched on demand via grep.

Consolidation is the bridge between layers: when a session ends or grows too large, an LLM call summarizes the conversation into a history entry and extracts durable facts into memory.

## Storage Layout

```
workspace/memory/
  MEMORY.md              # long-term facts, always in context
  HISTORY.md             # append-only log (all time, backward compat)
  HISTORY-2026-01.md     # monthly rotation
  HISTORY-2026-02.md
  ...
```

### MEMORY.md

- Loaded into the agent's system prompt on every message via `ContextBuilder`.
- Contains user preferences, project context, relationships, technical decisions.
- Written atomically by `MemoryManager.writeMemory()`.
- Auto-compressed when byte size exceeds `maxMemorySize` (default 8192). The consolidation prompt instructs the LLM to prune stale/low-value facts.

### HISTORY.md / HISTORY-YYYY-MM.md

- Append-only. Never truncated, never loaded into context automatically.
- The agent searches it with `grep -i "keyword" memory/HISTORY*.md`.
- Each entry is timestamped with an ISO header: `## 2026-02-27T14:30:00.000Z`.
- `appendHistoryRotated()` writes to both the main file and the monthly file. Main file exists for backward compatibility; monthly files keep grep fast as history grows.

## Components

### MemoryManager (`src/memory/memory.ts`)

Owns the filesystem. No LLM calls, no network I/O.

| Method | Description |
|--------|-------------|
| `readMemory()` | Returns MEMORY.md contents (empty string if missing) |
| `writeMemory(content)` | Overwrites MEMORY.md |
| `appendHistory(entry)` | Appends to HISTORY.md only (legacy) |
| `appendHistoryRotated(entry)` | Appends to both HISTORY.md and HISTORY-YYYY-MM.md |

### ConsolidationService (`src/memory/consolidation.ts`)

Owns LLM interaction for memory consolidation. Fully injectable — takes a `PromptFn` instead of importing SDK globals.

**Constructor:** `(promptFn, model, maxMemorySize?)`

**Public API:** `consolidate(messages, currentMemory) -> Promise<ConsolidationResult>`

Key internals:

- **Sequential queue** — `drain()` loop processes one consolidation at a time. Concurrent callers get queued. This prevents race conditions on MEMORY.md when multiple sessions consolidate simultaneously.
- **Memory compression** — When `currentMemory.length > maxMemorySize`, the prompt includes an instruction to compress and prune stale facts.
- **3-tier JSON parsing** — LLMs don't always return clean JSON:
  1. Strip markdown fences, `JSON.parse()` directly
  2. Extract first `{...}` block via brace-depth matching, parse that
  3. Regex extraction of `"history_entry"` and `"memory_update"` fields individually

**Consolidation prompt structure:**

```
You are a memory consolidation agent. Return JSON with:
  "history_entry": summary paragraph with [YYYY-MM-DD HH:MM] timestamp
  "memory_update": updated long-term memory content

## Current Long-term Memory
<current MEMORY.md or "(empty)">

## Conversation to Process
<formatted messages>

[compression instruction if memory exceeds limit]
```

### Types (`src/memory/types.ts`)

```ts
interface ConversationEntry {
  role: string;
  content: string;
  timestamp?: string;
  toolsUsed?: string[];
}

interface ConsolidationResult {
  historyEntry?: string;
  memoryUpdate?: string;
}

type PromptFn = (message: string, options: { model: string }) => Promise<{ content: string }>;
```

## Consolidation Triggers

### 1. `/new` command (session reset)

In `NeovateAgent.processMessage()`:

```
user sends /new
  -> read session messages
  -> await consolidateWithTimeout(messages)
  -> resetSession (clear JSONL, close SDK session)
  -> reply "Session cleared."
```

Consolidation is **awaited** (not fire-and-forget) so that memory is persisted before the session is destroyed. A configurable timeout (`consolidationTimeout`, default 30s) prevents the user from being blocked indefinitely.

### 2. Auto-consolidation (session overflow)

When `messageCount > memoryWindow`:

```
  -> compute cutoff = messages.length - keepCount
  -> consolidate messages[lastConsolidated..cutoff]
  -> trimBefore(cutoff) in SessionManager
  -> close SDK session (forces recreation with recap)
```

After trimming, remaining messages are formatted into a recap string and injected into the system prompt of the new SDK session. This provides conversational continuity without re-executing tool calls.

## Timeout and Fallback

`consolidateWithTimeout()` in NeovateAgent:

```
Promise.race([
  consolidationService.consolidate(messages, currentMemory),
  timeout(consolidationTimeout)
])
```

- **On success:** Apply `historyEntry` via `appendHistoryRotated()`, apply `memoryUpdate` via `writeMemory()` if changed.
- **On timeout/error:** Write a `[raw-fallback]` entry to history containing the last 10 messages (truncated to 200 chars each). No data is lost.

## Configuration

In `AgentConfig` (`src/config/schema.ts`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxMemorySize` | `number?` | `8192` | Byte threshold before LLM is asked to compress MEMORY.md |
| `consolidationTimeout` | `number?` | `30000` | Ms timeout for consolidation LLM calls |
| `memoryWindow` | `number` | `50` | Message count before auto-consolidation triggers |

## Session Metadata Preservation

`SessionManager.flush()` preserves the original `createdAt` timestamp from the session object instead of generating a new one. This prevents `trimBefore()` and `updateConsolidated()` from corrupting the session creation time in the JSONL file.

The `Session` interface carries `createdAt: string`, populated from the JSONL metadata line on load.

## Data Flow Diagram

```
  User message
       |
       v
  NeovateAgent.processMessage()
       |
       |-- messageCount > memoryWindow?
       |     yes -> consolidateWithTimeout(old messages)
       |              |
       |              v
       |         ConsolidationService.consolidate()
       |              |  (queued, sequential)
       |              v
       |         LLM prompt() call
       |              |
       |              v
       |         parseResponse() [3-tier]
       |              |
       |              v
       |         { historyEntry, memoryUpdate }
       |              |
       |         MemoryManager.appendHistoryRotated()
       |         MemoryManager.writeMemory()
       |              |
       |         SessionManager.trimBefore()
       |         build recap -> inject into system prompt
       |
       v
  SDK session processes message normally
```

## Explicitly Out of Scope

- Vector/embedding-based memory search
- Cross-workspace memory sharing
- Manual memory editing UI
- History file cleanup/garbage collection (monthly files accumulate indefinitely)
- Structured memory schema (MEMORY.md is free-form markdown)
