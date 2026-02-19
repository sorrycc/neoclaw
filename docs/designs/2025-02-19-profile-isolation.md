# Profile Isolation: `--profile` and `--dev` Global CLI Args

**Date:** 2025-02-19
**Status:** Approved

## Summary

Add `--profile <name>` and `--dev` global CLI flags to isolate all state under `~/.neoclaw-<name>` (or `~/.neoclaw-dev`).

## Design

### CLI Args (global, before subcommands)

- `--profile <name>` → base dir becomes `~/.neoclaw-<name>`
- `--dev` → shorthand for `--profile dev`
- No flag → `~/.neoclaw` (unchanged)
- `--dev --profile <anything>` → exit with error: "Cannot use --dev and --profile together"
- `--profile` with no value → exit with usage error

### Changes

**`src/index.ts`**

Parse `--profile` / `--dev` at top of `main()`, before any subcommand routing:

```ts
const { profile, dev } = argv;
if (dev && profile) {
  console.error("Error: Cannot use --dev and --profile together");
  process.exit(1);
}
if (profile === true) {
  console.error("Error: --profile requires a name");
  process.exit(1);
}
const resolvedProfile = dev ? "dev" : (profile as string | undefined);
const baseDir = resolvedProfile
  ? join(homedir(), `.neoclaw-${resolvedProfile}`)
  : join(homedir(), ".neoclaw");
```

Pass `baseDir` to all 4 `loadConfig(baseDir)` call sites.

**`src/config/schema.ts`**

- `loadConfig()` → `loadConfig(baseDir: string)`
- `configPath()` → `configPath(baseDir: string)` → `join(baseDir, "config.json")`
- Remove `DEFAULT_BASE` constant
- Compute default workspace inside `loadConfig` as `join(baseDir, "workspace")`
- `ensureWorkspaceDirs` unchanged (already takes workspace string)

### Directory Layout

```
~/.neoclaw/              # default
  config.json
  workspace/{memory,skills}/

~/.neoclaw-mybot/        # --profile mybot
  config.json
  workspace/{memory,skills}/

~/.neoclaw-dev/          # --dev
  config.json
  workspace/{memory,skills}/
```

### What Does NOT Change

- All downstream code (channels, bus, agent, services) — receives config with correct paths already baked in
- Env var overrides (`NEOCLAW_TELEGRAM_TOKEN` etc.) — applied after file loading, unaffected
- No new files, no new dependencies

### Scope

~30 lines across 2 files: `src/index.ts` and `src/config/schema.ts`.
