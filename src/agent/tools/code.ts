import { join } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { createSession, createTool, _zod as z } from "@neovate/code";
import type { Config } from "../../config/schema.js";

export function createCodeTool(opts: { config: Config }): ReturnType<typeof createTool> {
  const { config } = opts;

  return createTool({
    name: "code",
    description: "Execute a coding task in a separate session. Spawns a stateless coding agent that can read/write files and run commands in the specified directory.",
    parameters: z.object({
      task: z.string().describe("The coding task prompt to execute"),
      cwd: z.string().describe("Absolute path to the working directory"),
      model: z.string().optional().describe("Model identifier to use. Defaults to the configured agent model if not provided"),
    }),
    async execute(params) {
      if (!existsSync(params.cwd)) {
        return { llmContent: `Error: directory not found: ${params.cwd}`, isError: true };
      }

      const model = params.model || config.agent.codeModel || config.agent.model;
      let session;

      try {
        session = await createSession({
          model,
          cwd: params.cwd,
          providers: config.providers,
        });

        await session.send(params.task);

        let result = "";
        for await (const m of session.receive()) {
          if (m.type === "result") {
            result = m.content;
          }
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const logsDir = join(config.agent.workspace, "logs");
        mkdirSync(logsDir, { recursive: true });
        const logPath = join(logsDir, `code-${timestamp}.md`);
        writeFileSync(logPath, `# Code Session ${timestamp}\n- cwd: ${params.cwd}\n- model: ${model}\n- task: ${params.task}\n\n## Result\n${result}\n`, "utf-8");

        return { llmContent: `${result}\n\nSession log: ${logPath}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { llmContent: `Error executing code task: ${msg}`, isError: true };
      } finally {
        if (session) session.close();
      }
    },
  });
}
