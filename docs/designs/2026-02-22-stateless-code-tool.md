# Stateless Code Tool

**Date:** 2026-02-22

## Context

Neoclaw's agent has tools for cron scheduling and file sending, but lacks the ability to delegate programming tasks to a separate coding sub-agent. The idea is to add a new tool under `src/agent/tools/` that spawns a dedicated `createSession` from `@neovate/code` to perform code-related tasks, using model configuration (including a new `smallModel` option) from `config.json`.

## Discussion

### Working Directory
Three options were considered: reusing the main agent's workspace, a per-call user-specified `cwd`, or a configurable default with per-call override. **Decision:** user-specified per call — the calling agent passes `cwd` as a parameter targeting any directory.

### Model Selection
Options ranged from always using `smallModel`, defaulting to `smallModel` with override, or letting the agent decide via parameter. **Decision:** agent decides via parameter — the tool accepts a `model` enum (`"default"` | `"small"`) and resolves to `config.agent.model` or `config.agent.smallModel`.

### Return Value
Options included text summary only, text plus changed file list, or full conversation log. **Decision:** return text summary plus the path to a persisted session log file.

### Session Lifecycle
Three approaches were explored:

1. **Stateless fire-and-forget** — each call creates a fresh session, executes, closes, returns.
2. **Keyed persistent sessions** — sessions kept alive in a Map keyed by `cwd` for multi-turn coding.
3. **Hybrid** — stateless but re-injects previous log as context for the same `cwd`.

**Decision:** Approach 1 (stateless). The outer agent already has multi-turn context, so persistent sub-sessions are YAGNI. Stateless is simpler with no leak risk.

## Approach

A single `createCodeTool(opts: { config: Config })` function following the existing tool pattern. Each invocation spins up a fresh `createSession`, sends the task, collects the result, closes the session, writes a log, and returns a summary with the log path. No state is retained between calls.

## Architecture

### New File: `src/agent/tools/code.ts`

**Factory:** `createCodeTool(opts: { config: Config })`

**Parameters (zod):**

| Param   | Type                      | Required | Description                          |
|---------|---------------------------|----------|--------------------------------------|
| `task`  | `string`                  | yes      | The coding task prompt to execute    |
| `cwd`   | `string`                  | yes      | Absolute path to working directory   |
| `model` | `enum("default","small")` | yes      | Which model to use from config       |

**Flow:**

1. Resolve model: `params.model === "small" ? config.agent.smallModel : config.agent.model`
2. Validate `cwd` exists, return error if not
3. `createSession({ model, cwd, providers: config.providers })`
4. `session.send(params.task)`
5. Iterate `session.receive()`, collect final result text
6. `session.close()` in a `finally` block
7. Write log to `{workspace}/logs/code-{ISO-timestamp}.md`
8. Return `{ llmContent: "<summary>\n\nLog: <logPath>" }`

**Log format (`workspace/logs/code-<timestamp>.md`):**

```
# Code Session <timestamp>
- cwd: /path/to/project
- model: anthropic/claude-sonnet-4-20250514
- task: <original prompt>

## Result
<final result text>
```

### Config Change: `src/config/schema.ts`

Add `smallModel: string` to `AgentConfig` interface. Default: `"anthropic/claude-haiku-3-20250414"`.

### Integration: `src/agent/neovate-agent.ts`

- Import and instantiate `createCodeTool({ config: this.config })`
- Add to the plugins `tool()` array alongside `cronTool` and `sendFileTool`

### Directory Setup: `ensureWorkspaceDirs`

Add `join(workspace, "logs")` to the directories list.

### Error Handling

- `cwd` not found → `{ llmContent: "Error: directory not found", isError: true }`
- Session throws → catch, close in `finally`, return error with `isError: true`

### Explicitly Out of Scope (YAGNI)

- Multi-turn sub-sessions
- Streaming progress back during sub-session execution
- File diff or change tracking
- Custom system prompts for the sub-session
