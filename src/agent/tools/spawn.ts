import { createTool, _zod as z } from "@neovate/code";
import type { SubagentManager } from "../../services/subagent.js";

export function createSpawnTool(opts: {
  subagentManager: SubagentManager;
  channel: string;
  chatId: string;
}): ReturnType<typeof createTool> {
  const { subagentManager, channel, chatId } = opts;

  return createTool({
    name: "spawn",
    description: "Spawn a background subagent for independent tasks. The subagent runs asynchronously and its result will be announced when done.",
    parameters: z.object({
      task: z.string().describe("The task prompt for the subagent to execute"),
      label: z.string().optional().describe("Human-readable label for tracking this subagent"),
    }),
    async execute(params) {
      try {
        const id = await subagentManager.spawn(params.task, channel, chatId, params.label);
        const display = params.label ? `"${params.label}" (${id})` : id;
        return { llmContent: `Subagent ${display} started. You will receive the result when it completes.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmContent: `Failed to spawn subagent: ${msg}`, isError: true };
      }
    },
  });
}
