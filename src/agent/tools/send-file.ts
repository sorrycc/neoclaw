import { createTool, _zod as z } from "@neovate/code";
import { existsSync } from "fs";

export function createSendFileTool(opts: { pendingMedia: string[]; workspace: string }): ReturnType<typeof createTool> {
  const { pendingMedia, workspace } = opts;

  return createTool({
    name: "send_file",
    description: "Send an image or file to the user. Accepts absolute paths or URLs. The file will be attached to your next reply.",
    parameters: z.object({
      path: z.string().describe("Absolute file path or URL to send"),
    }),
    async execute(params) {
      const { path } = params;
      const isUrl = path.startsWith("http://") || path.startsWith("https://");

      if (!isUrl) {
        if (!existsSync(path)) {
          return { llmContent: `File not found: ${path}`, isError: true };
        }
      }

      pendingMedia.push(path);
      return { llmContent: `File queued for sending: ${path}` };
    },
  });
}
