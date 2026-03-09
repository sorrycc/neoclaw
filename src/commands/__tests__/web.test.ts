import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Config } from "../../config/schema.js";
import {
  buildCustomModelsUrl,
  buildOpenAiCompatibleModelsUrl,
  createConfigSnapshot,
  discoverCustomProviderModels,
  discoverOpenAiCompatibleModels,
  ensureWebUiBuilt,
  hasConfigFile,
  listConfigSnapshots,
  parseWebHost,
  parseWebPort,
  readConfigSnapshotPreview,
  readSnapshotConfig,
  resolveAutoStartCommand,
  triggerAutoStart,
} from "../web.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProjectRoot(suffix: string): string {
  const root = join("/tmp", `neoclaw-web-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(root);
  mkdirSync(join(root, "webapp"), { recursive: true });
  writeFileSync(join(root, "webapp", "package.json"), JSON.stringify({ name: "webapp", private: true }), "utf-8");
  return root;
}

function writeWebBuildDeps(projectRoot: string): void {
  const files = [
    join(projectRoot, "webapp", "node_modules", "vite", "package.json"),
    join(projectRoot, "webapp", "node_modules", "typescript", "package.json"),
    join(projectRoot, "webapp", "node_modules", "@vitejs", "plugin-react", "package.json"),
  ];
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}", "utf-8");
  }
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
        qq: { enabled: false, appId: "", clientSecret: "", allowFrom: [], requireMention: true },
      },
      logLevel: "debug",
    } as Config;

    const s1 = createConfigSnapshot(baseDir, cfg, "before-import");
    expect(s1.id).toContain("before-import");
    expect(s1.reason).toBe("before-import");
    const all = listConfigSnapshots(baseDir);
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]?.reason).toBe("before-import");
    const read = readSnapshotConfig(baseDir, s1.id);
    expect(read.channels.feishu.appId).toBe("cli_1");
  });

  it("returns masked snapshot preview metadata", () => {
    const baseDir = join("/tmp", `neoclaw-web-snapshot-preview-${Date.now()}`);
    tmpDirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });

    const cfg = {
      agent: { model: "openai/gpt-5", memoryWindow: 50, workspace: join(baseDir, "workspace") },
      channels: {
        telegram: { enabled: true, token: "tg-secret", allowFrom: [] },
        cli: { enabled: true },
        dingtalk: { enabled: true, clientId: "ding-id", clientSecret: "ding-secret", robotCode: "robot", allowFrom: [] },
        feishu: { enabled: true, appId: "cli_1", appSecret: "feishu-secret", allowFrom: [], connectionMode: "websocket" },
      },
      logLevel: "info",
    } as Config;

    const snapshot = createConfigSnapshot(baseDir, cfg, "before-rollback");
    const preview = readConfigSnapshotPreview(baseDir, snapshot.id);

    expect(preview.snapshot.id).toBe(snapshot.id);
    expect(preview.snapshot.reason).toBe("before-rollback");
    expect(preview.config.channels.telegram.token).toBe("********");
    expect(preview.config.channels.dingtalk.clientSecret).toBe("********");
    expect(preview.config.channels.feishu.appSecret).toBe("********");
    expect(preview.config.channels.telegram.token).not.toBe("tg-secret");
  });

  it("throws for unknown snapshot preview ids", () => {
    const baseDir = join("/tmp", `neoclaw-web-snapshot-missing-${Date.now()}`);
    tmpDirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });

    expect(() => readConfigSnapshotPreview(baseDir, "missing.json")).toThrow("snapshot not found");
  });

  it("rebuilds existing web dist on startup when webapp sources exist", () => {
    const projectRoot = createTempProjectRoot("rebuild-existing");
    const webappDist = join(projectRoot, "webapp", "dist");
    const distWeb = join(projectRoot, "dist", "web");
    const builtIndex = join(distWeb, "index.html");
    writeWebBuildDeps(projectRoot);
    mkdirSync(webappDist, { recursive: true });
    writeFileSync(join(webappDist, "index.html"), "<html>old</html>", "utf-8");

    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const resolved = ensureWebUiBuilt({
      projectRoot,
      cwd: projectRoot,
      runner: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        mkdirSync(dirname(builtIndex), { recursive: true });
        writeFileSync(builtIndex, "<html>rebuilt</html>", "utf-8");
        return { status: 0 };
      },
    });

    expect(calls).toEqual([
      { cmd: "bun", args: ["run", "build:web"], cwd: projectRoot },
    ]);
    expect(resolved).toBe(distWeb);
  });

  it("reuses existing dist when only packaged web assets are available", () => {
    const projectRoot = join("/tmp", `neoclaw-web-packaged-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpDirs.push(projectRoot);
    const distWeb = join(projectRoot, "dist", "web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "index.html"), "<html>packaged</html>", "utf-8");

    let calls = 0;
    const resolved = ensureWebUiBuilt({
      projectRoot,
      cwd: projectRoot,
      runner: () => {
        calls += 1;
        return { status: 0 };
      },
    });

    expect(calls).toBe(0);
    expect(resolved).toBe(distWeb);
  });

  it("builds compatible models URL and prefixes discovered custom models", async () => {
    expect(buildOpenAiCompatibleModelsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models");
    expect(buildCustomModelsUrl("https://api.anthropic.com/v1", "anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(buildCustomModelsUrl("https://generativelanguage.googleapis.com/v1beta", "google")).toBe("https://generativelanguage.googleapis.com/v1beta/models");

    const models = await discoverOpenAiCompatibleModels(
      "custom-1",
      "https://api.example.com/v1",
      "sk-test",
      async (input, init) => {
        expect(String(input)).toBe("https://api.example.com/v1/models");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-4.1" },
            { id: "gpt-4.1" },
            { id: "o3-mini" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    expect(models).toEqual([
      { label: "gpt-4.1", value: "custom-1/gpt-4.1" },
      { label: "o3-mini", value: "custom-1/o3-mini" },
    ]);
  });

  it("discovers anthropic models with native headers", async () => {
    const models = await discoverCustomProviderModels(
      "custom-claude",
      "https://api.anthropic.com/v1",
      "anthropic",
      "sk-ant-test",
      async (input, init) => {
        expect(String(input)).toBe("https://api.anthropic.com/v1/models");
        expect(init?.headers).toMatchObject({
          "x-api-key": "sk-ant-test",
          "anthropic-version": "2023-06-01",
        });
        return new Response(JSON.stringify({
          data: [
            { id: "claude-sonnet-4-5" },
            { id: "claude-opus-4-1" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    expect(models).toEqual([
      { label: "claude-sonnet-4-5", value: "custom-claude/claude-sonnet-4-5" },
      { label: "claude-opus-4-1", value: "custom-claude/claude-opus-4-1" },
    ]);
  });

  it("discovers google models from the native list response", async () => {
    const models = await discoverCustomProviderModels(
      "custom-google",
      "https://generativelanguage.googleapis.com/v1beta",
      "google",
      "google-api-key",
      async (input, init) => {
        expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=google-api-key");
        expect(init?.headers).toMatchObject({ Accept: "application/json" });
        return new Response(JSON.stringify({
          models: [
            { name: "models/gemini-2.5-pro" },
            { name: "models/gemini-2.0-flash" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    expect(models).toEqual([
      { label: "gemini-2.5-pro", value: "custom-google/gemini-2.5-pro" },
      { label: "gemini-2.0-flash", value: "custom-google/gemini-2.0-flash" },
    ]);
  });

  it("uses openai-compatible discovery for responses format", async () => {
    const models = await discoverCustomProviderModels(
      "custom-responses",
      "https://api.openai.com/v1",
      "responses",
      "sk-test",
      async (input, init) => {
        expect(String(input)).toBe("https://api.openai.com/v1/models");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-5" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    expect(models).toEqual([
      { label: "gpt-5", value: "custom-responses/gpt-5" },
    ]);
  });

  it("builds web dist automatically when missing and deps exist", () => {
    const projectRoot = createTempProjectRoot("build-only");
    const distWeb = join(projectRoot, "dist", "web");
    const builtIndex = join(distWeb, "index.html");
    writeWebBuildDeps(projectRoot);

    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const resolved = ensureWebUiBuilt({
      projectRoot,
      cwd: projectRoot,
      runner: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        mkdirSync(dirname(builtIndex), { recursive: true });
        writeFileSync(builtIndex, "<html>built</html>", "utf-8");
        return { status: 0 };
      },
    });

    expect(calls).toEqual([
      { cmd: "bun", args: ["run", "build:web"], cwd: projectRoot },
    ]);
    expect(resolved).toBe(distWeb);
  });

  it("installs web deps before building when tooling is missing", () => {
    const projectRoot = createTempProjectRoot("install-first");
    const distWeb = join(projectRoot, "dist", "web");
    const builtIndex = join(distWeb, "index.html");
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];

    const resolved = ensureWebUiBuilt({
      projectRoot,
      cwd: projectRoot,
      runner: (cmd, args, cwd) => {
        calls.push({ cmd, args, cwd });
        if (args[0] === "install") {
          writeWebBuildDeps(projectRoot);
          return { status: 0 };
        }
        mkdirSync(dirname(builtIndex), { recursive: true });
        writeFileSync(builtIndex, "<html>built</html>", "utf-8");
        return { status: 0 };
      },
    });

    expect(calls).toEqual([
      { cmd: "bun", args: ["install"], cwd: join(projectRoot, "webapp") },
      { cmd: "bun", args: ["run", "build:web"], cwd: projectRoot },
    ]);
    expect(resolved).toBe(distWeb);
  });

  it("resolves neoclaw auto-start command outside bun runtime", () => {
    const command = resolveAutoStartCommand({
      startArgs: ["--profile", "demo"],
      cwd: "/tmp/neoclaw-shell",
      useBunRuntime: false,
    });

    expect(command).toEqual({
      mode: "neoclaw",
      cmd: "neoclaw",
      args: ["--profile", "demo"],
      cwd: "/tmp/neoclaw-shell",
      display: "neoclaw --profile demo",
    });
  });

  it("resolves bun auto-start command in bun runtime", () => {
    const command = resolveAutoStartCommand({
      startArgs: ["--dev"],
      projectRoot: "/tmp/neoclaw-project",
      useBunRuntime: true,
    });

    expect(command).toEqual({
      mode: "bun",
      cmd: "bun",
      args: ["run", "start", "--", "--dev"],
      cwd: "/tmp/neoclaw-project",
      display: "bun run start -- --dev",
    });
  });

  it("requests transition into the main agent when not already running", async () => {
    const baseDir = join("/tmp", `neoclaw-auto-start-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const first = await triggerAutoStart(baseDir, {
      enabled: true,
      startArgs: ["--profile", "demo"],
      cwd: "/tmp/neoclaw-shell",
      useBunRuntime: false,
    });

    expect(first).toMatchObject({
      enabled: true,
      started: true,
      command: "neoclaw --profile demo",
    });
  });

  it("does not start again when runtime status says agent is already running", async () => {
    const baseDir = join("/tmp", `neoclaw-runtime-running-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpDirs.push(baseDir);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, "runtime-status.json"), JSON.stringify({
      updatedAt: new Date().toISOString(),
      agent: {
        running: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        profileDir: baseDir,
      },
      channels: {},
      recentErrors: [],
    }), "utf-8");

    const result = await triggerAutoStart(baseDir, {
      enabled: true,
      startArgs: ["--dev"],
      cwd: "/tmp/neoclaw-shell",
      useBunRuntime: false,
    });

    expect(result).toMatchObject({
      enabled: true,
      started: false,
      alreadyStarted: true,
      command: "neoclaw --dev",
      pid: process.pid,
    });
  });
});
