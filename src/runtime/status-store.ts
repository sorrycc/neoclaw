import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ChannelName } from "../bus/types.js";

export interface RuntimeErrorEntry {
  time: string;
  scope: string;
  message: string;
}

export interface ChannelRuntimeStatus {
  configuredEnabled: boolean;
  running: boolean;
  lastStartAt?: string;
  lastStopAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface RuntimeStatusSnapshot {
  updatedAt: string;
  agent: {
    running: boolean;
    pid: number | null;
    startedAt?: string;
    stoppedAt?: string;
    profileDir?: string;
  };
  channels: Record<string, ChannelRuntimeStatus>;
  recentErrors: RuntimeErrorEntry[];
}

const MAX_ERRORS = 60;

function nowIso(): string {
  return new Date().toISOString();
}

function asMessage(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function createEmptySnapshot(profileDir?: string): RuntimeStatusSnapshot {
  return {
    updatedAt: nowIso(),
    agent: {
      running: false,
      pid: null,
      profileDir,
    },
    channels: {},
    recentErrors: [],
  };
}

export function runtimeStatusPath(baseDir: string): string {
  return join(baseDir, "runtime-status.json");
}

export function readRuntimeStatusSnapshot(baseDir: string): RuntimeStatusSnapshot {
  const path = runtimeStatusPath(baseDir);
  if (!existsSync(path)) return createEmptySnapshot(baseDir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RuntimeStatusSnapshot;
    if (!raw || typeof raw !== "object") return createEmptySnapshot(baseDir);
    return {
      ...createEmptySnapshot(baseDir),
      ...raw,
      agent: { ...createEmptySnapshot(baseDir).agent, ...(raw.agent || {}) },
      channels: { ...(raw.channels || {}) },
      recentErrors: Array.isArray(raw.recentErrors) ? raw.recentErrors.slice(-MAX_ERRORS) : [],
      updatedAt: raw.updatedAt || nowIso(),
    };
  } catch {
    return createEmptySnapshot(baseDir);
  }
}

export class RuntimeStatusStore {
  private readonly path: string;
  private snapshot: RuntimeStatusSnapshot;

  constructor(private baseDir: string) {
    this.path = runtimeStatusPath(baseDir);
    this.snapshot = readRuntimeStatusSnapshot(baseDir);
    this.snapshot.agent.profileDir = baseDir;
  }

  markAgentRunning(): void {
    this.snapshot.agent.running = true;
    this.snapshot.agent.pid = process.pid;
    this.snapshot.agent.startedAt = nowIso();
    this.snapshot.agent.stoppedAt = undefined;
    this.persist();
  }

  markAgentStopped(): void {
    this.snapshot.agent.running = false;
    this.snapshot.agent.pid = null;
    this.snapshot.agent.stoppedAt = nowIso();
    this.persist();
  }

  markChannelConfigured(channel: ChannelName, enabled: boolean): void {
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      configuredEnabled: enabled,
    };
    this.persist();
  }

  markChannelRunning(channel: ChannelName, running: boolean): void {
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      running,
      lastStartAt: running ? nowIso() : current.lastStartAt,
      lastStopAt: running ? current.lastStopAt : nowIso(),
    };
    this.persist();
  }

  markChannelError(channel: ChannelName, err: unknown): void {
    const msg = asMessage(err);
    const current = this.snapshot.channels[channel] || { configuredEnabled: false, running: false };
    this.snapshot.channels[channel] = {
      ...current,
      lastErrorAt: nowIso(),
      lastError: msg,
    };
    this.pushError(`channel:${channel}`, msg);
    this.persist();
  }

  pushError(scope: string, err: unknown): void {
    const msg = asMessage(err);
    this.snapshot.recentErrors.push({
      time: nowIso(),
      scope,
      message: msg,
    });
    if (this.snapshot.recentErrors.length > MAX_ERRORS) {
      this.snapshot.recentErrors = this.snapshot.recentErrors.slice(-MAX_ERRORS);
    }
    this.persist();
  }

  getSnapshot(): RuntimeStatusSnapshot {
    return {
      ...this.snapshot,
      agent: { ...this.snapshot.agent },
      channels: { ...this.snapshot.channels },
      recentErrors: this.snapshot.recentErrors.map((x) => ({ ...x })),
    };
  }

  private persist(): void {
    this.snapshot.updatedAt = nowIso();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.snapshot, null, 2), "utf-8");
  }
}

