import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { MemoryRetrievalService } from "../../../memory/retrieval.js";
import { createMemoryGetTool, createMemorySearchTool } from "../memory.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory tools", () => {
  it("searches memory and fetches full chunks by id", async () => {
    const baseDir = join("/tmp", `neoclaw-memory-tools-${Date.now()}`);
    const workspace = join(baseDir, "workspace");
    const memoryDir = join(workspace, "memory");
    tmpDirs.push(baseDir);

    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "MEMORY.md"),
      [
        "# Preferences",
        "",
        "User prefers concise Chinese responses for status updates.",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(memoryDir, "HISTORY-2026-03.md"),
      [
        "## 2026-03-06T12:30:00.000Z",
        "We decided to expose memory_search and memory_get tools.",
      ].join("\n"),
      "utf-8",
    );

    const retrieval = await MemoryRetrievalService.create(workspace, { enabled: true, autoRecall: true, maxResults: 5 });
    const searchTool = createMemorySearchTool({ memoryRetrieval: retrieval });
    const getTool = createMemoryGetTool({ memoryRetrieval: retrieval });

    const searchResult = await searchTool.execute({ query: "memory get tools", limit: 3 });
    expect(searchResult.llmContent).toContain("Memory search results");
    expect(searchResult.llmContent).toContain("id=");

    const hit = (await retrieval.search("memory get tools", { limit: 1 }))[0];
    expect(hit).toBeDefined();

    const getResult = await getTool.execute({ id: hit!.id });
    expect(getResult.llmContent).toContain(hit!.id);
    expect(getResult.llmContent).toContain("memory_get tools");
  });
});
