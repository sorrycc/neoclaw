import { createSession, type SDKSession } from "@neovate/code";
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";
import type { Config } from "../config/schema.js";
import { logger } from "../logger.js";

interface SubagentTask {
  id: string;
  label: string;
  session: SDKSession;
  originChannel: string;
  originChatId: string;
}

const SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent. Your job is to complete the assigned task independently.

Rules:
- Complete the task fully, then stop.
- Do not ask questions — make reasonable assumptions.
- Stay within the workspace directory provided.
- Do not spawn further subagents or schedule cron jobs.
`;

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();

  constructor(private config: Config, private bus: MessageBus) {}

  async spawn(
    taskPrompt: string,
    originChannel: string,
    originChatId: string,
    label?: string,
  ): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    const displayLabel = label || "task";

    const workspace = this.config.agent.workspace;
    const session = await createSession({
      model: this.config.agent.model,
      cwd: workspace,
      providers: this.config.providers,
      plugins: [
        {
          config() {
            return {
              tools: {
                spawn: false,
                cron: false,
                send_file: false,
                code: false,
                ExitPlanMode: false,
                AskUserQuestion: false,
              },
            };
          },
          systemPrompt(original) {
            return `${original}\n\n${SUBAGENT_SYSTEM_PROMPT}\nWorkspace: ${workspace}`;
          },
        },
      ],
    });

    const task: SubagentTask = { id, label: displayLabel, session, originChannel, originChatId };
    this.tasks.set(id, task);
    logger.info("subagent", `spawned ${id} (${displayLabel})`);

    this.runTask(task, taskPrompt).catch((err) => {
      logger.error("subagent", `${id} failed:`, err);
      this.bus.publishInbound({
        channel: "system",
        senderId: `subagent:${id}`,
        chatId: `${task.originChannel}:${task.originChatId}`,
        content: `[Subagent ${id} "${displayLabel}" error]: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date(),
        media: [],
        metadata: { subagentId: id, originChannel: task.originChannel, originChatId: task.originChatId },
      });
    });

    return id;
  }

  private async runTask(task: SubagentTask, taskPrompt: string): Promise<void> {
    const timeout = this.config.agent.subagentTimeout ?? DEFAULT_TIMEOUT;

    try {
      const result = await Promise.race([
        this.executeSession(task, taskPrompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("subagent timeout")), timeout),
        ),
      ]);

      const msg: InboundMessage = {
        channel: "system",
        senderId: `subagent:${task.id}`,
        chatId: `${task.originChannel}:${task.originChatId}`,
        content: `[Subagent ${task.id} "${task.label}" completed]\nTask: ${taskPrompt}\n\nResult:\n${result}\n\nPlease summarize this result naturally for the user.`,
        timestamp: new Date(),
        media: [],
        metadata: { subagentId: task.id, originChannel: task.originChannel, originChatId: task.originChatId },
      };
      this.bus.publishInbound(msg);
    } finally {
      logger.info("subagent", `completed ${task.id}`);
      task.session.close();
      this.tasks.delete(task.id);
    }
  }

  private async executeSession(task: SubagentTask, taskPrompt: string): Promise<string> {
    await task.session.send(taskPrompt);

    let result = "";
    for await (const m of task.session.receive()) {
      if (m.type === "result") result = m.content;
    }
    return result;
  }
}
