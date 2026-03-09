import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { readRuntimeStatusSnapshot, RuntimeStatusStore } from "../status-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeStatusStore", () => {
  it("tracks agent/channel state and recent errors", () => {
    const baseDir = join("/tmp", `neoclaw-runtime-status-${Date.now()}`);
    tmpDirs.push(baseDir);
    const store = new RuntimeStatusStore(baseDir);

    store.markAgentRunning();
    store.markChannelConfigured("feishu", true);
    store.markChannelRunning("feishu", true);
    store.markChannelError("feishu", new Error("ws failed"));
    store.pushError("main:test", "synthetic");
    store.markChannelRunning("feishu", false);
    store.markAgentStopped();

    const snap = readRuntimeStatusSnapshot(baseDir);
    expect(snap.agent.running).toBe(false);
    expect(snap.channels.feishu.configuredEnabled).toBe(true);
    expect(snap.channels.feishu.running).toBe(false);
    expect(snap.channels.feishu.lastError).toContain("ws failed");
    expect(snap.recentErrors.length).toBeGreaterThan(0);
  });
});
