import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { MemoryFlushService } from "../flush.js";
import { MemoryRetrievalService } from "../retrieval.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("MemoryRetrievalService", () => {
  it("indexes memory and history, then updates on file changes", async () => {
    const baseDir = join("/tmp", `neoclaw-memory-retrieval-${Date.now()}`);
    const workspace = join(baseDir, "workspace");
    const memoryDir = join(workspace, "memory");
    tmpDirs.push(baseDir);

    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "MEMORY.md"),
      [
        "# Preferences",
        "",
        "User prefers Feishu webhook mode for team notifications.",
        "",
        "# Projects",
        "",
        "Memory evolution work is tracked in the neoclaw repo.",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(memoryDir, "HISTORY-2026-03.md"),
      [
        "## 2026-03-06T10:30:00.000Z",
        "We decided to add a pre-trim memory flush before session consolidation.",
      ].join("\n"),
      "utf-8",
    );

    const service = await MemoryRetrievalService.create(workspace, {
      enabled: true,
      autoRecall: true,
      maxResults: 5,
    });

    const memoryHits = await service.search("Feishu webhook preference");
    expect(memoryHits.length).toBeGreaterThan(0);
    expect(memoryHits[0]?.sourceKind).toBe("memory");
    expect(memoryHits[0]?.snippet).toContain("Feishu webhook mode");

    const recall = await service.buildRecallSection("你还记得我们之前决定了什么吗？");
    expect(recall).toContain("Relevant Memory Recall");
    expect(recall).toContain("HISTORY-2026-03.md");

    writeFileSync(
      join(memoryDir, "MEMORY.md"),
      [
        "# Preferences",
        "",
        "User prefers Telegram for urgent alerts.",
      ].join("\n"),
      "utf-8",
    );

    const updatedHits = await service.search("Telegram urgent alerts");
    expect(updatedHits.length).toBeGreaterThan(0);
    expect(updatedHits[0]?.snippet).toContain("Telegram for urgent alerts");
  });
});

describe("MemoryFlushService", () => {
  it("parses fenced JSON responses", async () => {
    const service = new MemoryFlushService(async () => ({
      content: [
        "```json",
        '{"memory_note":"- User prefers Feishu webhook mode","history_note":"[2026-03-06 18:00] Decided to add pre-trim flush."}',
        "```",
      ].join("\n"),
    }), "openai/gpt-5");

    const result = await service.flush([
      { role: "user", content: "Please remember we want a pre-trim flush.", timestamp: "2026-03-06T10:00:00.000Z" },
    ], "");

    expect(result.memoryNote).toContain("Feishu webhook mode");
    expect(result.historyNote).toContain("pre-trim flush");
  });
});
