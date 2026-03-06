import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Config } from "../../config/schema.js";
import {
  createConfigSnapshot,
  ensureWebUiBuilt,
  hasConfigFile,
  listConfigSnapshots,
  parseWebHost,
  parseWebPort,
  readSnapshotConfig,
} from "../web.js";

const tmpDirs: string[] = [];
const cleanupFns: Array<() => void> = [];

afterEach(() => {
  while (cleanupFns.length > 0) cleanupFns.pop()?.();
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function backupPath(target: string): string | null {
  if (!existsSync(target)) return null;
  const backup = `${target}.bak-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  renameSync(target, backup);
  cleanupFns.push(() => {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(backup, target);
  });
  return backup;
}

function cleanupCreatedPath(target: string): void {
  cleanupFns.push(() => {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  });
}

describe("web command helpers", () => {
  it("parses host with default fallback", () => {
    expect(parseWebHost("0.0.0.0")).toBe("0.0.0.0");
    expect(parseWebHost("")).toBe("127.0.0.1");
    expect(parseWebHost(undefined)).toBe("127.0.0.1");
  });

  it("parses port with bounds and fallback", () => {
    expect(parseWebPort("8788")).toBe(8788);
    expect(parseWebPort(65535)).toBe(65535);
    expect(parseWebPort(0)).toBe(8788);
    expect(parseWebPort(99999)).toBe(8788);
    expect(parseWebPort("abc")).toBe(8788);
  });

  it("detects config file existence", () => {
    const baseDir = join("/tmp", `neoclaw-web-test-${Date.now()}`);
    tmpDirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });

    expect(hasConfigFile(baseDir)).toBe(false);
    writeFileSync(join(baseDir, "config.json"), "{}", "utf-8");
    expect(hasConfigFile(baseDir)).toBe(true);
  });

  it("creates and reads config snapshots", () => {
    const baseDir = join("/tmp", `neoclaw-web-snapshot-test-${Date.now()}`);
    tmpDirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });

    const cfg = {
      agent: { model: "openai/gpt-5", memoryWindow: 50, workspace: join(baseDir, "workspace") },
      channels: {
        telegram: { enabled: false, token: "", allowFrom: [] },
        cli: { enabled: true },
        dingtalk: { enabled: false, clientId: "", clientSecret: "", robotCode: "", allowFrom: [] },
        feishu: { enabled: true, appId: "cli_1", appSecret: "sec_1", allowFrom: [], connectionMode: "websocket" },
      },
      logLevel: "debug",
    } as Config;

    const s1 = createConfigSnapshot(baseDir, cfg, "before-import");
    expect(s1.id).toContain("before-import");
    const all = listConfigSnapshots(baseDir);
    expect(all.length).toBeGreaterThan(0);
    const read = readSnapshotConfig(baseDir, s1.id);
    expect(read.channels.feishu.appId).toBe("cli_1");
  });

  it("reuses existing web dist without rebuilding", () => {
    const repoRoot = process.cwd();
    const webappDist = join(repoRoot, "webapp", "dist");
    const indexPath = join(webappDist, "index.html");
    const distWeb = join(repoRoot, "dist", "web");

    backupPath(webappDist);
    backupPath(distWeb);
    mkdirSync(webappDist, { recursive: true });
    writeFileSync(indexPath, "<html>ok</html>", "utf-8");
    cleanupCreatedPath(webappDist);

    let calls = 0;
    const resolved = ensureWebUiBuilt(() => {
      calls += 1;
      return { status: 0 };
    });

    expect(calls).toBe(0);
    expect(resolved).toBe(webappDist);
  });

  it("builds web dist automatically when missing", () => {
    const repoRoot = process.cwd();
    const webappDist = join(repoRoot, "webapp", "dist");
    const distWeb = join(repoRoot, "dist", "web");
    const builtIndex = join(distWeb, "index.html");

    backupPath(webappDist);
    backupPath(distWeb);
    cleanupCreatedPath(webappDist);
    cleanupCreatedPath(distWeb);

    let calls = 0;
    const resolved = ensureWebUiBuilt((_cmd, _args, cwd) => {
      calls += 1;
      expect(cwd).toBe(repoRoot);
      mkdirSync(dirname(builtIndex), { recursive: true });
      writeFileSync(builtIndex, "<html>built</html>", "utf-8");
      return { status: 0 };
    });

    expect(calls).toBe(1);
    expect(resolved).toBe(distWeb);
  });
});
