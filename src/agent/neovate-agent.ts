import { join } from "path";
import { createSession, prompt, type SDKSession } from "@neovate/code";
import type { Agent } from "./agent.js";
import type { ChannelName, InboundMessage, OutboundMessage } from "../bus/types.js";
import { sessionKey } from "../bus/types.js";
import { ContextBuilder } from "./context.js";
import { SkillManager } from "./skill-manager.js";
import { MediaQueue } from "./media-queue.js";
import { resolveMedia } from "./media-resolver.js";
import { processStream } from "./stream-processor.js";
import { SessionManager } from "../session/manager.js";
import { MemoryManager } from "../memory/memory.js";
import { ConsolidationService } from "../memory/consolidation.js";
import { MemoryFlushService } from "../memory/flush.js";
import { MemoryRetrievalService } from "../memory/retrieval.js";
import type { ConversationEntry } from "../memory/types.js";
import type { Config } from "../config/schema.js";
import type { CronService } from "../services/cron.js";
import { logger } from "../logger.js";
import { createCronTool } from "./tools/cron.js";
import { createSendFileTool } from "./tools/send-file.js";
import { createCodeTool } from "./tools/code.js";
import { createSpawnTool } from "./tools/spawn.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools/memory.js";
import { SubagentManager } from "../services/subagent.js";
import type { MessageBus } from "../bus/message-bus.js";

export class NeovateAgent implements Agent {
  private sessions = new Map<string, SDKSession>();
  private mediaQueues = new Map<string, MediaQueue>();
  private contextBuilder: ContextBuilder;
  private skillManager: SkillManager;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager;
  private consolidationService: ConsolidationService;
  private memoryFlushService: MemoryFlushService;
  private memoryRetrieval: MemoryRetrievalService;
  private subagentManager: SubagentManager;

  private constructor(
    private config: Config,
    private cronService: CronService,
    private bus: MessageBus,
    sessionManager: SessionManager,
    memoryManager: MemoryManager,
    memoryRetrieval: MemoryRetrievalService,
  ) {
    this.memoryManager = memoryManager;
    this.memoryRetrieval = memoryRetrieval;
    this.contextBuilder = new ContextBuilder(config.agent.workspace, this.memoryManager);
    this.skillManager = new SkillManager(config.agent.workspace);
    this.sessionManager = sessionManager;
    this.subagentManager = new SubagentManager(config, bus);
    this.consolidationService = new ConsolidationService(
      (message, options) => prompt(message, options),
      config.agent.model,
      config.agent.maxMemorySize ?? 8192,
    );
    this.memoryFlushService = new MemoryFlushService(
      (message, options) => prompt(message, options),
      config.agent.model,
    );
  }

  static async create(config: Config, cronService: CronService, bus: MessageBus): Promise<NeovateAgent> {
    const sessionsDir = join(config.agent.workspace, "..", "sessions");
    const sessionManager = await SessionManager.create(sessionsDir);
    const memoryManager = await MemoryManager.create(config.agent.workspace);
    const memoryRetrieval = await MemoryRetrievalService.create(config.agent.workspace, config.agent.memorySearch);
    return new NeovateAgent(config, cronService, bus, sessionManager, memoryManager, memoryRetrieval);
  }

  async *processMessage(msg: InboundMessage): AsyncGenerator<OutboundMessage> {
    const key = sessionKey(msg);
    const outChannel = (msg.metadata.originChannel as ChannelName) || msg.channel;
    const outChatId = (msg.metadata.originChatId as string) || msg.chatId;
    const reply = (content: string, progress = false): OutboundMessage => ({
      channel: outChannel, chatId: outChatId, content, media: [], metadata: { progress },
    });

    const commandResult = yield* this.handleCommand(msg, key, reply);
    if (commandResult) return;

    let sessionRecap = await this.manageSessionWindow(key);

    if (!sessionRecap && !this.sessions.has(key)) {
      const existing = await this.sessionManager.get(key);
      if (existing.messages.length > 0) {
        sessionRecap = existing.messages
          .filter((m) => m.content)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n");
      }
    }

    const mediaQueue = this.ensureMediaQueue(key);
    const sdkSession = await this.ensureSession(key, msg, mediaQueue, sessionRecap);

    await this.sessionManager.append(key, "user", msg.content);
    await this.sendMessage(sdkSession, msg);

    const stream = processStream(sdkSession, reply);
    let finalContent = "";
    for (;;) {
      const { value, done } = await stream.next();
      if (done) { finalContent = value; break; }
      yield value;
    }

    await this.sessionManager.append(key, "assistant", finalContent);
    const media = mediaQueue.drain();
    if (finalContent || media.length > 0) {
      logger.debug("agent", `yield: final content=${JSON.stringify(finalContent).slice(0, 80)} media=${media.length}`);
      yield { channel: outChannel, chatId: outChatId, content: finalContent, media, metadata: { progress: false } };
    }
  }

  private async *handleCommand(
    msg: InboundMessage,
    key: string,
    reply: (content: string, progress?: boolean) => OutboundMessage,
  ): AsyncGenerator<OutboundMessage, boolean> {
    if (msg.content === "/new") {
      const session = await this.sessionManager.get(key);
      if (session.messages.length > 0) {
        await this.consolidateWithTimeout(session.messages);
      }
      await this.resetSession(key);
      yield reply("Session cleared.");
      return true;
    }

    if (msg.content === "/stop") {
      const session = this.sessions.get(key);
      if (session) {
        if (typeof (session as any).abort === "function") await (session as any).abort();
        yield reply("Agent stopped.");
      } else {
        yield reply("No active session.");
      }
      return true;
    }

    if (msg.content === "/help") {
      const skills = await this.skillManager.getSkills();
      const skillLines = skills.map((s) => s.description ? `/${s.name} - ${s.description}` : `/${s.name}`).join("\n");
      const base = "Commands:\n/new - Start a new session\n/stop - Stop the current agent\n/help - Show this help";
      yield reply(skillLines ? `${base}\n\nSkills:\n${skillLines}` : base);
      return true;
    }

    return false;
  }

  private async manageSessionWindow(key: string): Promise<string | undefined> {
    const keepCount = Math.floor(this.config.agent.memoryWindow / 2);
    if ((await this.sessionManager.messageCount(key)) <= this.config.agent.memoryWindow) {
      return undefined;
    }

    const session = await this.sessionManager.get(key);
    const cutoff = session.messages.length - keepCount;
    const oldMessages = session.messages.slice(session.lastConsolidated, cutoff);
    if (oldMessages.length > 0) {
      await this.flushMemoryBeforeTrim(oldMessages);
      await this.consolidateWithTimeout(oldMessages);
    }
    await this.sessionManager.trimBefore(key, cutoff);

    let sessionRecap: string | undefined;
    const remaining = (await this.sessionManager.get(key)).messages;
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

    return sessionRecap;
  }

  private ensureMediaQueue(key: string): MediaQueue {
    if (!this.mediaQueues.has(key)) {
      this.mediaQueues.set(key, new MediaQueue());
    }
    return this.mediaQueues.get(key)!;
  }

  private async ensureSession(
    key: string,
    msg: InboundMessage,
    mediaQueue: MediaQueue,
    sessionRecap?: string,
  ): Promise<SDKSession> {
    let sdkSession = this.sessions.get(key);
    if (sdkSession) return sdkSession;

    const systemContext = await this.contextBuilder.getSystemContext(msg.channel, msg.chatId);
    const cronTool = createCronTool({ cronService: this.cronService, channel: msg.channel, chatId: msg.chatId });
    const sendFileTool = createSendFileTool({ mediaQueue, workspace: this.config.agent.workspace });
    const codeTool = createCodeTool({ config: this.config });
    const spawnTool = createSpawnTool({ subagentManager: this.subagentManager, channel: msg.channel, chatId: msg.chatId });
    const memorySearchTool = createMemorySearchTool({ memoryRetrieval: this.memoryRetrieval });
    const memoryGetTool = createMemoryGetTool({ memoryRetrieval: this.memoryRetrieval });
    const recapSection = sessionRecap
      ? `\n\n## Recent Conversation Recap\nThe session was trimmed for context management. Here is a recap of recent messages:\n${sessionRecap}`
      : "";

    sdkSession = await createSession({
      model: this.config.agent.model,
      cwd: this.config.agent.workspace,
      skills: await this.skillManager.getSkillPaths(),
      providers: this.config.providers,
      plugins: [
        {
          config() {
            return {
              outputStyle: "Minimal",
              tools: { task: false, ExitPlanMode: false, AskUserQuestion: false },
            };
          },
          systemPrompt(original) {
            return `${original}\n\n${systemContext}${recapSection}`;
          },
          tool() {
            return [cronTool, sendFileTool, codeTool, spawnTool, memorySearchTool, memoryGetTool];
          },
        }
      ],
    });
    this.sessions.set(key, sdkSession);
    return sdkSession;
  }

  private async sendMessage(sdkSession: SDKSession, msg: InboundMessage): Promise<void> {
    const messageContent = (await this.skillManager.resolveSkillCommand(msg.content)) ?? msg.content;
    const recallSection = await this.memoryRetrieval.buildRecallSection(messageContent);
    const enrichedMessage = recallSection
      ? `${recallSection}\n\n## User Message\n${messageContent}`
      : messageContent;

    if (msg.media.length > 0) {
      const parts = await resolveMedia(msg.media, enrichedMessage);
      await sdkSession.send({
        type: "user",
        message: parts,
        parentUuid: null,
        uuid: crypto.randomUUID(),
        sessionId: (sdkSession as any).sessionId,
      });
    } else {
      await sdkSession.send(enrichedMessage);
    }
  }

  private async flushMemoryBeforeTrim(messages: ConversationEntry[]): Promise<void> {
    if (!this.config.agent.memoryFlush?.enabled) return;
    const timeout = this.config.agent.memoryFlush?.timeoutMs ?? 8000;
    const currentMemory = await this.memoryManager.readMemory();

    try {
      const result = await Promise.race([
        this.memoryFlushService.flush(messages, currentMemory),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("memory flush timeout")), timeout)
        ),
      ]);

      let changed = false;
      if (result.memoryNote) {
        changed = (await this.memoryManager.mergeDurableNote(result.memoryNote)) || changed;
      }
      if (result.historyNote) {
        await this.memoryManager.appendHistoryRotated(result.historyNote);
        changed = true;
      }
      if (changed) {
        await this.memoryRetrieval.sync();
      }
    } catch (error) {
      logger.warn("agent", "memory flush failed, continuing with normal consolidation:", error);
    }
  }

  private async consolidateWithTimeout(messages: ConversationEntry[]): Promise<void> {
    const timeout = this.config.agent.consolidationTimeout ?? 30000;
    const currentMemory = await this.memoryManager.readMemory();

    try {
      const result = await Promise.race([
        this.consolidationService.consolidate(messages, currentMemory),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("consolidation timeout")), timeout)
        ),
      ]);

      let changed = false;
      if (result.historyEntry) {
        await this.memoryManager.appendHistoryRotated(result.historyEntry);
        changed = true;
      }
      if (result.memoryUpdate && result.memoryUpdate !== currentMemory) {
        await this.memoryManager.writeMemory(result.memoryUpdate);
        changed = true;
      }
      if (changed) {
        await this.memoryRetrieval.sync();
      }
      logger.info("agent", `consolidation ok, historyEntry=${!!result.historyEntry} memoryUpdated=${result.memoryUpdate !== currentMemory}`);
    } catch (err) {
      logger.error("agent", "consolidation failed or timed out:", err);
      const summary = messages
        .filter((m) => m.content)
        .slice(-10)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      await this.memoryManager.appendHistoryRotated(`[raw-fallback] Consolidation failed. Recent messages:\n${summary}`);
      await this.memoryRetrieval.sync();
    }
  }

  updateConfig(config: Config): void {
    this.config = config;
    this.consolidationService.updateModel(config.agent.model);
    this.consolidationService.updateMaxMemorySize(config.agent.maxMemorySize ?? 8192);
    this.memoryFlushService.updateModel(config.agent.model);
    this.memoryRetrieval.updateConfig(config.agent.memorySearch);
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
    this.mediaQueues.delete(key);
    await this.sessionManager.clear(key);
  }
}
