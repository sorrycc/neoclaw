import { createSession, type SDKSession } from "@neovate/code";
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";
import type { Config } from "../config/schema.js";
import { logger } from "../logger.js";

interface SubagentTask {
  id: string;
  session: SDKSession;
  originChannel: string;
  originChatId: string;
}

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();
  private nextId = 0;

  constructor(private config: Config, private bus: MessageBus) {}

  async spawn(
    taskPrompt: string,
    originChannel: string,
    originChatId: string
  ): Promise<string> {
    const id = `subagent_${++this.nextId}`;

    const session = await createSession({
      model: this.config.agent.model,
      cwd: this.config.agent.workspace,
      providers: this.config.providers,
    });

    const task: SubagentTask = { id, session, originChannel, originChatId };
    this.tasks.set(id, task);
    logger.info("subagent", `spawned ${id}`);

    this.runTask(task, taskPrompt).catch((err) => {
      logger.error("subagent", `${id} failed:`, err);
    });

    return id;
  }

  private async runTask(task: SubagentTask, taskPrompt: string): Promise<void> {
    try {
      await task.session.send(taskPrompt);

      let result = "";
      for await (const m of task.session.receive()) {
        if (m.type === "result") result = m.content;
      }

      const msg: InboundMessage = {
        channel: "system",
        senderId: `subagent:${task.id}`,
        chatId: `${task.originChannel}:${task.originChatId}`,
        content: `[Subagent ${task.id} result]:\n${result}`,
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
}
