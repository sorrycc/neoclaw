# Cron System

**Date:** 2026-02-27

## Overview

Timer-based job scheduler that fires synthetic `InboundMessage`s into the message bus. Supports three schedule types: one-shot (`at`), recurring interval (`every`), and cron expressions (`cron`). Jobs persist to disk and survive restarts.

## Core Interface

```typescript
interface CronJob {
  id: string;
  type: "at" | "every" | "cron";
  schedule: string | number;  // seconds for "every", ISO string for "at", cron expr for "cron"
  payload: { message: string; channel: string; chatId: string };
  enabled: boolean;            // supports pause/resume
  lastRun?: string;
  nextRun?: string;            // computed next fire time (ISO string)
}
```

## Schedule Types

| Type | `schedule` value | Behavior |
|------|-----------------|----------|
| `at` | ISO datetime string | Fires once, then auto-removes from storage |
| `every` | seconds (number) | Fires repeatedly at fixed interval (service converts to ms internally) |
| `cron` | cron expression (5-field) | Fires at next matching time, re-arms after each fire |

## Architecture

- **Storage:** `~/.neoclaw/data/cron/jobs.json` — async read/write via `fs/promises`
- **Timers:** `Map<jobId, setTimeout handle>` — one active timer per job
- **Lifecycle:** `constructor()` → `init()` (async load) → `start()` (arms all jobs, blocks via promise) → `stop()` (clears timers, resolves start promise)
- **Firing:** Publishes `InboundMessage` with `channel: "system"`, `senderId: "cron"` into the message bus. The agent processes it like any other message.

## Input Validation

Validation happens in `addJob()` before persisting:

- `every`: must be a positive finite number
- `at`: must be a valid future ISO datetime
- `cron`: must parse with `cron-parser`

Invalid input throws descriptive errors. Callers (CLI command, LLM tool) catch and surface them.

## Pause / Resume

- `pauseJob(id)`: sets `enabled=false`, clears timer, saves
- `resumeJob(id)`: sets `enabled=true`, re-arms timer, saves
- `armJob()` skips disabled jobs
- Old jobs missing `enabled` are migrated to `enabled: true` on load

## Entry Points

| Layer | File | Notes |
|-------|------|-------|
| Service | `src/services/cron.ts` | Core logic, timer management, persistence |
| CLI | `src/commands/cron.ts` | `neoclaw cron {list,add,remove,pause,resume}` |
| LLM tool | `src/agent/tools/cron.ts` | Tool the agent calls during conversations |
| Skill doc | `workspace/skills/cron/SKILL.md` | Loaded into agent context for scheduling tasks |
