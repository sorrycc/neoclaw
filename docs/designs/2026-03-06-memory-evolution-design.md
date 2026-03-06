# Neoclaw Memory Evolution Design

**Date:** 2026-03-06

## Context

Neoclaw currently uses a simple two-layer memory system:

- `workspace/memory/MEMORY.md` for curated long-term facts injected into every session.
- `workspace/memory/HISTORY.md` and `HISTORY-YYYY-MM.md` for append-only history searched by keyword.

This design is operationally simple and fits Neoclaw's positioning as a lightweight personal assistant, but it has two known limits:

1. Recall quality depends heavily on exact keywords.
2. Important facts can be missed right before session trimming or compaction.

The goal of this design is to improve recall and memory durability without turning Neoclaw into a heavy memory platform.

## Decision

Adopt an incremental memory architecture inspired by OpenClaw's direction, not Memoh-v2's full database-native memory stack.

Selected direction:

- Keep Markdown files as the source of truth.
- Add a local retrieval layer using SQLite FTS5.
- Add optional embedding-based semantic search on top of the same file corpus.
- Add a pre-trim memory flush turn before session consolidation.
- Keep the current LLM consolidation flow as the writer for durable memory.

Rejected direction:

- Do not introduce Qdrant, external vector infrastructure, or record-level ADD/UPDATE/DELETE memory objects in the first iteration.

## Why This Approach

This path keeps the core properties that already match Neoclaw well:

- Human-readable memory that can be inspected and edited directly.
- Local-first operation with minimal moving parts.
- Easy backup and recovery because files remain canonical.
- Low deployment complexity for a single-user personal assistant.

Compared with alternatives:

- **Current design only:** simplest, but recall quality degrades as history grows.
- **Memoh-v2 style stack:** stronger retrieval and memory operations, but too heavy for the current product scope.
- **OpenClaw style evolution:** improves recall materially while preserving the file-based mental model.

## Goals

- Improve memory recall for fuzzy or paraphrased queries.
- Preserve current Markdown-based workflows and operator visibility.
- Avoid blocking user interactions on expensive indexing or embedding work.
- Keep implementation local-first and optional-feature-friendly.
- Support gradual rollout behind config flags.

## Non-Goals

- Multi-tenant memory serving.
- Shared memory across workspaces or users.
- A full memory CRUD UI.
- Distributed vector databases or external search services.
- Fully structured semantic triples or graph memory.

## Target Architecture

The target system keeps the existing files and adds a retrieval index beside them.

```text
workspace/
  memory/
    MEMORY.md
    HISTORY.md
    HISTORY-2026-03.md
    ...

state/
  memory/
    index.sqlite           # FTS tables + metadata
    embeddings.sqlite?     # optional, can be merged into index.sqlite
```

Core layers:

1. **Source of truth**
   - `MEMORY.md` stores durable facts.
   - `HISTORY*.md` stores append-only event logs.

2. **Writer pipeline**
   - Existing consolidation updates `MEMORY.md` and appends `HISTORY*.md`.
   - New pre-trim flush may write durable notes before old context is dropped.

3. **Retrieval layer**
   - SQLite FTS5 indexes chunked snippets from `MEMORY.md` and `HISTORY*.md`.
   - Optional embeddings index the same chunks for semantic recall.
   - Search merges lexical and semantic candidates into one ranked result set.

4. **Context injection layer**
   - Instead of always forcing the model to rely on `grep`, expose an internal memory search tool or helper path.
   - Search results are injected only when needed and under budget.

## Storage Design

### Canonical files

Keep the current file layout unchanged for compatibility:

```text
workspace/memory/
  MEMORY.md
  HISTORY.md
  HISTORY-YYYY-MM.md
```

Behavior remains:

- `MEMORY.md` is always loaded in system context.
- `HISTORY*.md` is append-only and not auto-injected.

### SQLite index

Introduce a local index file, for example:

```text
~/.neoclaw/state/memory/<profile>.sqlite
```

Suggested schema:

```sql
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_kind TEXT NOT NULL,      -- memory | history
  month_bucket TEXT,              -- YYYY-MM for history
  section_key TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER
);

CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  content,
  source_path UNINDEXED,
  source_kind UNINDEXED,
  content='memory_chunks',
  content_rowid='rowid'
);

CREATE TABLE memory_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Optional embedding table:

```sql
CREATE TABLE memory_embeddings (
  chunk_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES memory_chunks(id) ON DELETE CASCADE
);
```

## Chunking Strategy

Chunking should stay simple and deterministic.

Rules:

- `MEMORY.md`
  - Split by markdown headings first.
  - If a section is too large, split into paragraph groups.
  - Preserve heading path in `section_key`.

- `HISTORY*.md`
  - Split by `## <ISO timestamp>` blocks.
  - Large entries may be subdivided into paragraph chunks.
  - Store month in `month_bucket`.

Defaults:

- Target chunk size: 400-800 characters.
- Soft max: 1200 characters.
- No overlap in V1 unless retrieval quality proves weak.

Rationale:

- Small enough for targeted retrieval.
- Large enough to preserve event meaning.
- Easy to rebuild deterministically from files.

## Search Pipeline

### Phase 1: FTS-only search

Search flow:

1. Normalize query.
2. Run SQLite FTS5 search.
3. Boost `MEMORY.md` hits over `HISTORY*.md` when scores are close.
4. Apply recency boost to recent history buckets.
5. Return top `N` snippets with path and line hints.

Suggested ranking factors:

- Lexical score from FTS.
- `MEMORY.md` source boost.
- Mild recency boost for history entries from the last 30 days.

### Phase 2: Hybrid search with optional embeddings

When embeddings are enabled:

1. Run FTS search and vector search in parallel.
2. Merge candidates by normalized score.
3. Deduplicate by `chunk_id` or `content_hash`.
4. Apply MMR-lite reranking to reduce near-duplicate snippets.
5. Enforce token or character budget before injection.

Hybrid scoring formula can remain simple:

```text
final_score = 0.65 * vector_score + 0.35 * lexical_score + source_boost + recency_boost
```

This should be configurable, but defaults should favor vector recall only after embeddings are proven stable.

## Retrieval API Shape

Introduce a dedicated memory retrieval surface in Neoclaw.

### Option A: Internal helper only

- Agent runtime decides when to search memory.
- Results are appended as an internal system section.

Pros:

- Simpler UX.
- Stronger control over when search happens.

Cons:

- Harder to inspect from agent behavior.

### Option B: Tool-backed retrieval

- Add `memory_search` and `memory_get` tools.
- The agent may call them when it needs prior context.

Pros:

- More explicit and debuggable.
- Matches future extensibility.

Cons:

- Depends more on model tool judgment.

Recommendation:

- Implement **both** layers over time.
- V1 should start with internal helper usage for automatic recall in obvious cases.
- V2 can expose `memory_search` and `memory_get` as tools for explicit agent-driven lookup.

Suggested result shape:

```ts
interface MemorySearchHit {
  id: string;
  path: string;
  sourceKind: "memory" | "history";
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  createdAt?: string;
}
```

## Memory Flush Design

Add a lightweight pre-trim memory flush before the session window is cut.

Trigger:

- When `messageCount` approaches or exceeds `memoryWindow` and older messages are about to be consolidated and trimmed.

Flow:

1. Detect pending trim.
2. Run a short silent prompt asking the model to write durable notes now.
3. Allow file write to `MEMORY.md` or a dated history note if needed.
4. If nothing should be written, do nothing.
5. Continue existing consolidation and trim pipeline.

Purpose:

- Reduce the chance that important user facts are only present in volatile session context.
- Improve memory capture before recap-only continuation.

Constraints:

- One flush per trim cycle.
- Timeout must be short.
- If flush fails, continue normal conversation flow.

## Consolidation Changes

Keep the current consolidation mechanism, but refine responsibilities.

### Keep

- LLM-based summary and durable-fact extraction.
- Sequential consolidation queue.
- Timeout fallback.
- Monthly history rotation.

### Adjust

- Consolidation should remain the primary writer to `HISTORY*.md`.
- Memory flush should write only clearly durable notes, not verbose summaries.
- Retrieval indexing should update incrementally after writes, not by rescanning on every query.

## Index Sync Strategy

The retrieval index should not become a source of latency.

Recommended sync rules:

- Mark files dirty when `MEMORY.md` or `HISTORY*.md` changes.
- Debounce sync for a short interval, for example 1-3 seconds.
- On search, if the index is stale, either:
  - perform a fast incremental sync first, or
  - serve last-good index and schedule sync immediately.

Implementation preference:

- Startup: full sync.
- Normal writes: incremental sync by touched file.
- Search path: never block longer than a small timeout budget.

## Context Injection Policy

Memory retrieval should stay budgeted and selective.

Policy:

- Always inject `MEMORY.md` as today.
- Search `HISTORY*.md` only when the user asks about prior decisions, dates, tasks, or preferences, or when the prompt clearly references prior work.
- Inject at most 4-6 snippets.
- Cap injected memory section to a small character budget.
- Prefer snippets from `MEMORY.md` over history when both answer the same need.

This avoids turning the memory layer into another large prompt dump.

## Configuration

Extend `AgentConfig` with a nested memory search section.

Suggested shape:

```ts
interface AgentConfig {
  model: string;
  codeModel?: string;
  memoryWindow: number;
  workspace: string;
  maxMemorySize?: number;
  consolidationTimeout?: number;
  subagentTimeout?: number;
  memorySearch?: {
    enabled?: boolean;
    provider?: "fts" | "hybrid";
    maxResults?: number;
    minScore?: number;
    indexPath?: string;
    autoRecall?: boolean;
    recencyHalfLifeDays?: number;
    embeddings?: {
      enabled?: boolean;
      model?: string;
      dims?: number;
    };
  };
  memoryFlush?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
}
```

Recommended defaults:

- `memorySearch.enabled = true`
- `memorySearch.provider = "fts"`
- `memorySearch.autoRecall = true`
- `memorySearch.maxResults = 5`
- `memoryFlush.enabled = true`

Embeddings stay opt-in until cost, stability, and quality are verified.

## Failure Handling

The system should degrade gracefully.

Failure cases and behavior:

- SQLite index missing or corrupt:
  - Log warning.
  - Rebuild in background.
  - Fall back to direct `grep` on `HISTORY*.md`.

- Embedding provider unavailable:
  - Disable vector path for this run.
  - Continue with FTS-only search.

- Memory flush timeout:
  - Log warning.
  - Continue normal consolidation path.

- Consolidation timeout:
  - Keep current raw fallback behavior.

## Rollout Plan

### Phase 0: Current baseline

- Keep current `MEMORY.md` + `HISTORY*.md` flow.

### Phase 1: Retrieval index

- Add SQLite schema and chunking.
- Index `MEMORY.md` and rotated history files.
- Add FTS-only memory search helper.
- Keep `grep` as fallback.

### Phase 2: Auto recall

- Add automatic memory lookup for obvious memory-sensitive prompts.
- Inject top snippets under budget.

### Phase 3: Memory flush

- Add pre-trim silent memory flush.
- Track one flush per trim cycle.

### Phase 4: Hybrid retrieval

- Add optional embeddings.
- Merge lexical and semantic candidates.
- Tune defaults based on real usage.

### Phase 5: Tool exposure

- Add `memory_search` and `memory_get` tools for explicit memory operations.

## Tradeoffs

Benefits:

- Much better recall than grep-only search.
- Retains file-based transparency.
- No external database dependency.
- Clear migration path with low operational risk.

Costs:

- More moving parts than the current design.
- Local index rebuild and sync logic adds maintenance burden.
- Embeddings introduce optional provider complexity.

Accepted tradeoff:

- Neoclaw will prefer moderate recall quality with strong simplicity, rather than maximum recall power with heavy infrastructure.

## Open Questions

- Should the retrieval index live under workspace or profile state directory?
- Should session JSONL files also become an optional retrieval source later?
- Should `MEMORY.md` gain soft structure conventions such as fixed sections for preferences, people, projects, and decisions?
- Should recall triggering be heuristic-only, or partly model-driven via explicit tools?

## Recommendation Summary

For Neoclaw's current product shape, the best memory evolution path is:

1. Preserve Markdown as the canonical memory store.
2. Add SQLite FTS5 retrieval first.
3. Add pre-trim memory flush.
4. Add optional embeddings only after the FTS path is stable.

This keeps the system lightweight, debuggable, and aligned with the personal assistant use case while materially improving recall quality.
