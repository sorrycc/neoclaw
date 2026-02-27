import { join } from "path";
import { readdirSync, existsSync, statSync, readFileSync } from "fs";
import { extname } from "path";
import { createSession, prompt, type SDKSession } from "@neovate/code";
import type { Agent } from "./agent.js";
import type { InboundMessage, OutboundMessage } from "../bus/types.js";
import { sessionKey } from "../bus/types.js";
import { ContextBuilder } from "./context.js";
import { SessionManager } from "../session/manager.js";
import { MemoryManager } from "../memory/memory.js";
import { ConsolidationService } from "../memory/consolidation.js";
import type { ConversationEntry } from "../memory/types.js";
import type { Config } from "../config/schema.js";
import type { CronService } from "../services/cron.js";
import { logger } from "../logger.js";
import { createCronTool } from "./tools/cron.js";
import { createSendFileTool } from "./tools/send-file.js";
import { createCodeTool } from "./tools/code.js";

export class NeovateAgent implements Agent {
  private sessions = new Map<string, SDKSession>();
  private pendingMediaMap = new Map<string, string[]>();
  private contextBuilder: ContextBuilder;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager;
  private consolidationService: ConsolidationService;

  constructor(private config: Config, private cronService: CronService) {
    this.memoryManager = new MemoryManager(config.agent.workspace);
    this.contextBuilder = new ContextBuilder(config.agent.workspace, this.memoryManager);
    this.sessionManager = new SessionManager(config.agent.workspace);
    this.consolidationService = new ConsolidationService(
      (message, options) => prompt(message, options),
      config.agent.model,
      config.agent.maxMemorySize ?? 8192,
    );
  }

  async *processMessage(msg: InboundMessage): AsyncGenerator<OutboundMessage> {
    const key = sessionKey(msg);
    const outChannel = (msg.metadata.originChannel as string) || msg.channel;
    const outChatId = (msg.metadata.originChatId as string) || msg.chatId;
    const reply = (content: string, progress = false): OutboundMessage => ({
      channel: outChannel, chatId: outChatId, content, media: [], metadata: { progress },
    });

    if (msg.content === "/new") {
      const session = this.sessionManager.get(key);
      if (session.messages.length > 0) {
        await this.consolidateWithTimeout(session.messages);
      }
      await this.resetSession(key);
      yield reply("Session cleared.");
      return;
    }

    if (msg.content === "/stop") {
      const session = this.sessions.get(key);
      if (session) {
        // @ts-ignore
        // wait for next version of @neovate/code
        await session.abort();
        yield reply("Agent stopped.");
      } else {
        yield reply("No active session.");
      }
      return;
    }

    if (msg.content === "/help") {
      const skills = this.getSkillNames();
      const skillLines = skills.map((s) => `/${s}`).join("\n");
      const base = "Commands:\n/new - Start a new session\n/stop - Stop the current agent\n/help - Show this help";
      yield reply(skillLines ? `${base}\n\nSkills:\n${skillLines}` : base);
      return;
    }

    let sessionRecap: string | undefined;
    const keepCount = Math.floor(this.config.agent.memoryWindow / 2);
    if (this.sessionManager.messageCount(key) > this.config.agent.memoryWindow) {
      const session = this.sessionManager.get(key);
      const cutoff = session.messages.length - keepCount;
      const oldMessages = session.messages.slice(session.lastConsolidated, cutoff);
      if (oldMessages.length > 0) {
        await this.consolidateWithTimeout(oldMessages);
      }
      this.sessionManager.trimBefore(key, cutoff);

      // Build recap from remaining messages for conversational continuity
      const remaining = this.sessionManager.get(key).messages;
      if (remaining.length > 0) {
        sessionRecap = remaining
          .filter((m) => m.content)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n");
      }

      const existing = this.sessions.get(key);
      if (existing) {
        existing.close();
        this.sessions.delete(key);
      }
    }

    if (!this.pendingMediaMap.has(key)) {
      this.pendingMediaMap.set(key, []);
    }
    const pendingMedia = this.pendingMediaMap.get(key)!;

    let sdkSession = this.sessions.get(key);
    if (!sdkSession) {
      const systemContext = this.contextBuilder.getSystemContext(msg.channel, msg.chatId);
      const cronTool = createCronTool({ cronService: this.cronService, channel: msg.channel, chatId: msg.chatId });
      const sendFileTool = createSendFileTool({ pendingMedia, workspace: this.config.agent.workspace });
      const codeTool = createCodeTool({ config: this.config });
      const recapSection = sessionRecap
        ? `\n\n## Recent Conversation Recap\nThe session was trimmed for context management. Here is a recap of recent messages:\n${sessionRecap}`
        : "";
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
                tools: {
                  ExitPlanMode: false,
                  AskUserQuestion: false,
                },
              };
            },
            systemPrompt(original) {
              return `${original}\n\n${systemContext}${recapSection}`;
            },
            tool() {
              return [cronTool, sendFileTool, codeTool];
            },
          }
        ],
      });
      this.sessions.set(key, sdkSession);
    }

    this.sessionManager.append(key, "user", msg.content);

    const messageContent = this.resolveSkillCommand(msg.content) ?? msg.content;

    if (msg.media.length > 0) {
      const imageMimes: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
      const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      const images: string[] = [];
      const files: string[] = [];
      for (const p of msg.media) {
        const ext = extname(p).toLowerCase();
        if (ext in imageMimes) images.push(p);
        else files.push(p);
      }
      const labels = [
        ...images.map((p) => `[Image: ${p}]`),
        ...files.map((p) => `[File: ${p}]`),
      ];
      parts.push({ type: "text", text: `${labels.join("\n")}${messageContent ? `\n${messageContent}` : ""}` });
      for (const filePath of images) {
        try {
          const buffer = readFileSync(filePath);
          const ext = extname(filePath).toLowerCase();
          parts.push({ type: "image", data: buffer.toString("base64"), mimeType: imageMimes[ext] });
        } catch (e) {
          logger.error("agent", `failed to read media file: ${filePath}`, e);
        }
      }
      await sdkSession.send({
        type: "user",
        message: parts,
        parentUuid: null,
        uuid: crypto.randomUUID(),
        sessionId: (sdkSession as any).sessionId,
      });
    } else {
      await sdkSession.send(messageContent);
    }

    let finalContent = "";
    for await (const m of sdkSession.receive()) {
      if (m.type === "system") {
        logger.debug("agent", `init session=${m.sessionId} model=${m.model} tools=${m.tools.join(",")}`);

      } else if (m.type === "message" && "role" in m && m.role === "assistant") {
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === "text" && part.text) {
              yield reply(part.text, true);
            } else if (part.type === "reasoning" && part.text) {
              logger.debug("agent", `thinking: ${part.text.slice(0, 120)}`);
              yield reply(part.text, true);
            } else if (part.type === "tool_use") {
              logger.debug("agent", `tool_use: ${part.displayName || part.name} id=${part.id} input=${JSON.stringify(part.input).slice(0, 100)}`);
            }
          }
        } else {
          const text = m.text || (typeof m.content === "string" ? m.content : "");
          if (text) yield reply(text, true);
        }

      } else if (m.type === "message" && "role" in m && (m.role === "tool" || m.role === "user")) {
        const parts = Array.isArray(m.content) ? m.content : [];
        for (const part of parts) {
          if ("name" in part) {
            const status = (part as any).result?.isError ? "error" : "ok";
            logger.debug("agent", `tool_result: ${(part as any).name} status=${status}`);
          }
        }

      } else if (m.type === "result") {
        finalContent = m.content;
        const status = m.isError ? "error" : "success";
        logger.debug("agent", `result: ${status} content=${JSON.stringify(finalContent).slice(0, 80)}`);
        if (m.usage) {
          logger.info("agent", `usage: in=${m.usage.input_tokens} out=${m.usage.output_tokens}`);
        }
      }
    }

    this.sessionManager.append(key, "assistant", finalContent);

    const media = pendingMedia.splice(0);

    if (finalContent || media.length > 0) {
      logger.debug("agent", `yield: final content=${JSON.stringify(finalContent).slice(0, 80)} media=${media.length}`);
      yield {
        channel: outChannel, chatId: outChatId, content: finalContent,
        media, metadata: { progress: false },
      };
    }
  }

  private async consolidateWithTimeout(messages: ConversationEntry[]): Promise<void> {
    const timeout = this.config.agent.consolidationTimeout ?? 30000;
    const currentMemory = this.memoryManager.readMemory();

    try {
      const result = await Promise.race([
        this.consolidationService.consolidate(messages, currentMemory),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("consolidation timeout")), timeout)
        ),
      ]);

      if (result.historyEntry) {
        this.memoryManager.appendHistoryRotated(result.historyEntry);
      }
      if (result.memoryUpdate && result.memoryUpdate !== currentMemory) {
        this.memoryManager.writeMemory(result.memoryUpdate);
      }
      logger.info("agent", `consolidation ok, historyEntry=${!!result.historyEntry} memoryUpdated=${result.memoryUpdate !== currentMemory}`);
    } catch (err) {
      logger.error("agent", "consolidation failed or timed out:", err);
      // Fallback: write raw summary so nothing is lost
      const summary = messages
        .filter((m) => m.content)
        .slice(-10)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      this.memoryManager.appendHistoryRotated(`[raw-fallback] Consolidation failed. Recent messages:\n${summary}`);
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

  private resolveSkillCommand(content: string): string | null {
    if (!content.startsWith("/")) return null;
    const spaceIdx = content.indexOf(" ");
    const command = spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();
    const skillDir = join(this.config.agent.workspace, "skills", command);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) return null;
    const raw = readFileSync(skillFile, "utf-8");
    const body = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
    let p = `Base directory for this skill: ${skillDir}\n\n${body}`;
    const hasPositional = /\$[1-9]\d*/.test(p);
    if (hasPositional) {
      const parsed = args.split(" ");
      for (let i = 0; i < parsed.length; i++) {
        p = p.replace(new RegExp(`\\$${i + 1}\\b`, "g"), parsed[i] || "");
      }
    } else if (p.includes("$ARGUMENTS")) {
      p = p.replace(/\$ARGUMENTS/g, args || "");
    } else if (args) {
      p += `\n\nArguments: ${args}`;
    }
    return p;
  }

  updateConfig(config: Config): void {
    this.config = config;
    this.consolidationService.updateModel(config.agent.model);
    this.consolidationService.updateMaxMemorySize(config.agent.maxMemorySize ?? 8192);
    for (const [key, session] of this.sessions) {
      session.close();
      this.sessions.delete(key);
    }
    logger.info("agent", `config updated, model=${config.agent.model}`);
  }

  private async resetSession(key: string): Promise<void> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.close();
      this.sessions.delete(key);
    }
    this.pendingMediaMap.delete(key);
    this.sessionManager.clear(key);
  }
}
