import { createSession, type SDKSession } from "@neovate/code";
import type { Agent } from "./agent.js";
import type { InboundMessage, OutboundMessage } from "../bus/types.js";
import { sessionKey } from "../bus/types.js";
import { ContextBuilder } from "./context.js";
import { SessionManager } from "../session/manager.js";
import { MemoryManager } from "../memory/memory.js";
import type { Config } from "../config/schema.js";

export class NeovateAgent implements Agent {
  private sessions = new Map<string, SDKSession>();
  private contextBuilder: ContextBuilder;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager;

  constructor(private config: Config) {
    this.contextBuilder = new ContextBuilder(config.agent.workspace);
    this.sessionManager = new SessionManager(config.agent.workspace);
    this.memoryManager = new MemoryManager(config.agent.workspace);
  }

  async processMessage(msg: InboundMessage): Promise<OutboundMessage | null> {
    const key = sessionKey(msg);

    if (msg.content === "/new") {
      await this.resetSession(key);
      return { channel: msg.channel, chatId: msg.chatId, content: "Session cleared.", media: [], metadata: {} };
    }

    if (msg.content === "/help") {
      const help = "Commands:\n/new - Start a new session\n/help - Show this help";
      return { channel: msg.channel, chatId: msg.chatId, content: help, media: [], metadata: {} };
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
      const systemContext = this.contextBuilder.getSystemContext();
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

    return {
      channel: msg.channel,
      chatId: msg.chatId,
      content: finalContent,
      media: [],
      metadata: {},
    };
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
