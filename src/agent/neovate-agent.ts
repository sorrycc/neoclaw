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
    this.memoryManager = new MemoryManager(config.agent.workspace);
    this.contextBuilder = new ContextBuilder(config.agent.workspace, this.memoryManager);
    this.sessionManager = new SessionManager(config.agent.workspace);
  }

  async *processMessage(msg: InboundMessage): AsyncGenerator<OutboundMessage> {
    const key = sessionKey(msg);
    const outChannel = (msg.metadata.originChannel as string) || msg.channel;
    const outChatId = (msg.metadata.originChatId as string) || msg.chatId;
    const reply = (content: string, progress = false): OutboundMessage => ({
      channel: outChannel, chatId: outChatId, content, media: [], metadata: { progress },
    });

    if (msg.content === "/new") {
      await this.resetSession(key);
      yield reply("Session cleared.");
      return;
    }

    if (msg.content === "/help") {
      const skills = this.getSkillNames();
      const skillLines = skills.map((s) => `/${s}`).join("\n");
      const base = "Commands:\n/new - Start a new session\n/help - Show this help";
      yield reply(skillLines ? `${base}\n\nSkills:\n${skillLines}` : base);
      return;
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
                // quiet: true,
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
      console.log(`[agent:receive] type=${m.type} role=${"role" in m ? m.role : "n/a"}`);
      if (m.type === "message" && "role" in m && m.role === "assistant") {
        const text = m.text || (typeof m.content === "string" ? m.content : "");
        if (text) {
          console.log(`[agent:yield] progress text=${JSON.stringify(text).slice(0, 80)}`);
          yield reply(text, true);
        }
      } else if (m.type === "result") {
        finalContent = m.content;
        console.log(`[agent:yield] result content=${JSON.stringify(finalContent).slice(0, 80)}`);
      }
    }

    this.sessionManager.append(key, "assistant", finalContent);

    if (finalContent) {
      console.log(`[agent:yield] final content=${JSON.stringify(finalContent).slice(0, 80)}`);
      yield reply(finalContent);
    }
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
