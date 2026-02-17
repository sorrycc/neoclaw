import { join } from "path";
import { readdirSync, existsSync, statSync } from "fs";
import { createSession, type SDKSession } from "@neovate/code";
import type { Agent } from "./agent.js";
import type { InboundMessage, OutboundMessage } from "../bus/types.js";
import { sessionKey } from "../bus/types.js";
import { ContextBuilder } from "./context.js";
import { SessionManager } from "../session/manager.js";
import { MemoryManager } from "../memory/memory.js";
import type { Config } from "../config/schema.js";
import type { CronService } from "../services/cron.js";
import { createCronTool } from "./tools/cron.js";

export class NeovateAgent implements Agent {
  private sessions = new Map<string, SDKSession>();
  private contextBuilder: ContextBuilder;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager;

  constructor(private config: Config, private cronService: CronService) {
    this.contextBuilder = new ContextBuilder(config.agent.workspace);
    this.sessionManager = new SessionManager(config.agent.workspace);
    this.memoryManager = new MemoryManager(config.agent.workspace);
  }

  async processMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
    const key = sessionKey(msg);
    const outChannel = (msg.metadata.originChannel as string) || msg.channel;
    const outChatId = (msg.metadata.originChatId as string) || msg.chatId;
    const reply = (content: string): OutboundMessage => ({
      channel: outChannel, chatId: outChatId, content, media: [], metadata: {},
    });

    if (msg.content === "/new") {
      await this.resetSession(key);
      return reply("Session cleared.");
    }

    if (msg.content === "/help") {
      const skills = this.getSkillNames();
      const skillLines = skills.map((s) => `/${s}`).join("\n");
      const base = "Commands:\n/new - Start a new session\n/help - Show this help\n/cron list - List scheduled jobs\n/cron add --every <seconds> <message>\n/cron add --at <ISO datetime> <message>\n/cron add --cron <expr> <message>\n/cron remove <id> - Remove a job";
      return reply(skillLines ? `${base}\n\nSkills:\n${skillLines}` : base);
    }

    if (msg.content.startsWith("/cron")) {
      return reply(this.handleCronCommand(msg));
    }

    if (this.sessionManager.messageCount(key) > this.config.agent.memoryWindow) {
      const session = this.sessionManager.get(key);
      const oldMessages = session.messages.slice(session.lastConsolidated);
      this.memoryManager.consolidate(oldMessages, this.config.agent.model).catch(() => {});
      this.sessionManager.updateConsolidated(key, session.messages.length);
      await this.resetSession(key);
    }

    let sdkSession = this.sessions.get(key);
    if (!sdkSession) {
      const systemContext = this.contextBuilder.getSystemContext(msg.channel, msg.chatId);
      const cronTool = createCronTool({ cronService: this.cronService, channel: msg.channel, chatId: msg.chatId });
      sdkSession = await createSession({
        model: this.config.agent.model,
        cwd: this.config.agent.workspace,
        skills: this.contextBuilder.getSkillPaths(),
        providers: this.config.providers,
        plugins: [
          {
            config() {
              return {
                outputStyle: 'Minimal',
              };
            },
            systemPrompt(original) {
              return `${original}\n\n${systemContext}`;
            },
            tool() {
              return [cronTool];
            },
          }
        ],
      });
      this.sessions.set(key, sdkSession);
    }

    this.sessionManager.append(key, "user", msg.content);

    await sdkSession.send(msg.content);

    let finalContent = "";
    for await (const m of sdkSession.receive()) {
      if (m.type === "result") {
        finalContent = m.content;
      }
    }

    this.sessionManager.append(key, "assistant", finalContent);

    return reply(finalContent);
  }

  private handleCronCommand(msg: InboundMessage): string {
    const parts = msg.content.trim().split(/\s+/);
    const action = parts[1];

    if (!action || action === "list") {
      const jobs = this.cronService.listJobs();
      if (!jobs.length) return "No scheduled jobs.";
      return jobs.map((j) => `[${j.id}] ${j.type}(${j.schedule}) — ${j.payload.message}`).join("\n");
    }

    if (action === "remove") {
      const id = parts[2];
      if (!id) return "Usage: /cron remove <id>";
      return this.cronService.removeJob(id) ? `Removed job ${id}` : `Job ${id} not found`;
    }

    if (action === "add") {
      const flag = parts[2];
      if (flag === "--every") {
        const seconds = parseInt(parts[3], 10);
        if (isNaN(seconds) || seconds <= 0) return "Usage: /cron add --every <seconds> <message>";
        const message = parts.slice(4).join(" ");
        if (!message) return "Usage: /cron add --every <seconds> <message>";
        const job = this.cronService.addJob({ type: "every", schedule: seconds * 1000, message, channel: msg.channel, chatId: msg.chatId });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      if (flag === "--at") {
        const at = parts[3];
        if (!at) return "Usage: /cron add --at <ISO datetime> <message>";
        const message = parts.slice(4).join(" ");
        if (!message) return "Usage: /cron add --at <ISO datetime> <message>";
        const job = this.cronService.addJob({ type: "at", schedule: at, message, channel: msg.channel, chatId: msg.chatId });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      if (flag === "--cron") {
        const exprParts: string[] = [];
        let i = 3;
        for (; i < parts.length; i++) {
          if (/^\d/.test(parts[i]) || parts[i] === "*") {
            exprParts.push(parts[i]);
          } else {
            break;
          }
        }
        const expr = exprParts.join(" ");
        const message = parts.slice(i).join(" ");
        if (!expr || !message) return "Usage: /cron add --cron <expr> <message>";
        const job = this.cronService.addJob({ type: "cron", schedule: expr, message, channel: msg.channel, chatId: msg.chatId });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      return "Usage: /cron add --every|--at|--cron <value> <message>";
    }

    return "Unknown cron action. Use: list, add, remove";
  }

  private getSkillNames(): string[] {
    const skillsDir = join(this.config.agent.workspace, "skills");
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir).filter((entry) => {
      const skillPath = join(skillsDir, entry);
      return statSync(skillPath).isDirectory() && existsSync(join(skillPath, "SKILL.md"));
    });
  }

  private async resetSession(key: string): Promise<void> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.close();
      this.sessions.delete(key);
    }
    this.sessionManager.clear(key);
  }
}
