import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Config } from "../../config/schema.js";
import {
  buildOpenAiCompatibleModelsUrl,
  createConfigSnapshot,
  discoverOpenAiCompatibleModels,
  ensureWebUiBuilt,
  hasConfigFile,
  listConfigSnapshots,
  parseWebHost,
  parseWebPort,
  readSnapshotConfig,
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
    const projectRoot = createTempProjectRoot("reuse");
    const webappDist = join(projectRoot, "webapp", "dist");
    mkdirSync(webappDist, { recursive: true });
    writeFileSync(join(webappDist, "index.html"), "<html>ok</html>", "utf-8");

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
    expect(resolved).toBe(webappDist);
  });

  it("builds compatible models URL and prefixes discovered custom models", async () => {
    expect(buildOpenAiCompatibleModelsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/models");

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
});
