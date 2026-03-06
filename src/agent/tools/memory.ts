import { createTool, _zod as z } from "@neovate/code";
import type { MemoryRetrievalService } from "../../memory/retrieval.js";

export function createMemorySearchTool(opts: { memoryRetrieval: MemoryRetrievalService }): ReturnType<typeof createTool> {
  const { memoryRetrieval } = opts;

  return createTool({
    name: "memory_search",
    description: "Search long-term memory and history for prior decisions, preferences, dates, and earlier work. Returns stable chunk ids that can be expanded with memory_get.",
    parameters: z.object({
      query: z.string().describe("What to search for in memory/history"),
      limit: z.number().optional().describe("Maximum number of hits to return"),
    }),
    async execute(params) {
      const hits = await memoryRetrieval.search(params.query, {
        limit: typeof params.limit === "number" ? Math.max(1, Math.floor(params.limit)) : undefined,
      });

      if (!hits.length) {
        return { llmContent: "No relevant memory hits found." };
      }

      const lines = hits.map((hit, index) => {
        const lineHint = hit.startLine ? `:${hit.startLine}` : "";
        return `${index + 1}. id=${hit.id} [${hit.sourceKind}] ${hit.path}${lineHint} score=${hit.score.toFixed(3)}\n   ${hit.snippet}`;
      });

      return {
        llmContent: `Memory search results for \"${params.query}\":\n${lines.join("\n")}`,
      };
    },
  });
}

export function createMemoryGetTool(opts: { memoryRetrieval: MemoryRetrievalService }): ReturnType<typeof createTool> {
  const { memoryRetrieval } = opts;

  return createTool({
    name: "memory_get",
    description: "Fetch the full content for a memory/history chunk by id after using memory_search.",
    parameters: z.object({
      id: z.string().describe("Chunk id returned by memory_search"),
    }),
    async execute(params) {
      const record = await memoryRetrieval.get(params.id);
      if (!record) {
        return { llmContent: `Memory chunk not found: ${params.id}`, isError: true };
      }

      const lineHint = record.startLine ? `:${record.startLine}` : "";
      const meta = [
        `id=${record.id}`,
        `source=${record.sourceKind}`,
        `path=${record.path}${lineHint}`,
        record.createdAt ? `createdAt=${record.createdAt}` : undefined,
      ].filter(Boolean).join("\n");

      return {
        llmContent: `${meta}\n\n${record.content}`,
      };
    },
  });
}
