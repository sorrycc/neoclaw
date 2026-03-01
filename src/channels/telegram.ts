import { Bot, InputFile } from "grammy";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, watch, type FSWatcher } from "fs";
import { tmpdir } from "os";
import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { TelegramConfig } from "../config/schema.js";
import type { OutboundMessage, InboundMessage } from "../bus/types.js";
import { logger } from "../logger.js";
import { markdownToIR, chunkMarkdownIR, type MarkdownLinkSpan } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
import { SkillManager } from "../agent/skill-manager.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href || link.start === link.end) return null;
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${escapeHtmlAttr(href)}">`,
    close: "</a>",
  };
}

const TELEGRAM_STYLE_MARKERS = {
  bold: { open: "<b>", close: "</b>" },
  italic: { open: "<i>", close: "</i>" },
  strikethrough: { open: "<s>", close: "</s>" },
  code: { open: "<code>", close: "</code>" },
  code_block: { open: "<pre><code>", close: "</code></pre>" },
  spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
  blockquote: { open: "<blockquote>", close: "</blockquote>" },
} as const;

function mdToTelegramHtml(md: string): string {
  const ir = markdownToIR(md ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
  });
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: TELEGRAM_STYLE_MARKERS,
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

type TelegramFormattedChunk = { html: string; text: string };

function mdToTelegramChunks(md: string, limit: number): TelegramFormattedChunk[] {
  const ir = markdownToIR(md ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => ({
    html: renderMarkdownWithMarkers(chunk, {
      styleMarkers: TELEGRAM_STYLE_MARKERS,
      escapeText: escapeHtml,
      buildLink: buildTelegramLink,
    }),
    text: chunk.text,
  }));
}

const CAPTION_LIMIT = 1024;
const TG_MSG_LIMIT = 4096;

function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function toMediaSource(s: string): string | InputFile {
  return isUrl(s) ? s : new InputFile(s);
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "flac", "m4a", "aac"]);

function extOf(path: string): string {
  const url = isUrl(path) ? new URL(path).pathname : path;
  return (url.split(".").pop() ?? "").toLowerCase();
}

function mediaType(path: string): "photo" | "video" | "audio" | "document" {
  const ext = extOf(path);
  if (IMAGE_EXTS.has(ext)) return "photo";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "document";
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private running = false;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private lastSentContent = new Map<string, { content: string; time: number }>();
  private botUsername = "";
  private skillsWatcher: FSWatcher | null = null;
  private skillsDebounce: ReturnType<typeof setTimeout> | null = null;
  private skillManager: SkillManager;
  private cachedSkills: { original: string; command: string; description: string }[] = [];

  constructor(private config: TelegramConfig, private bus: MessageBus, private workspace: string) {
    this.bot = new Bot(config.token);
    this.skillManager = new SkillManager(workspace);
  }

  private isGroupChat(chatType: string): boolean {
    return chatType === "group" || chatType === "supergroup";
  }

  private extractMention(text: string): { mentioned: boolean; cleaned: string } {
    if (!this.botUsername) return { mentioned: false, cleaned: text };
    const mention = `@${this.botUsername}`;
    if (!text.includes(mention)) return { mentioned: false, cleaned: text };
    return { mentioned: true, cleaned: text.replaceAll(mention, "").replace(/\s+/g, " ").trim() };
  }

  private isAllowed(senderId: string): boolean {
    if (this.config.allowFrom.length === 0) return true;
    return this.config.allowFrom.some((a) => senderId.includes(a));
  }

  private isReplyToBot(ctx: { message?: { reply_to_message?: { from?: { id: number } } } }): boolean {
    return ctx.message?.reply_to_message?.from?.id === this.bot.botInfo.id;
  }

  private senderIdFrom(ctx: { from?: { id: number; username?: string } }): string {
    return `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
  }

  private guardInbound(ctx: { chat: { id: number; type: string }; from?: { id: number; username?: string } }):
    { allowed: false } | { allowed: true; senderId: string; chatId: string } {
    const senderId = this.senderIdFrom(ctx);
    if (!this.isAllowed(senderId)) return { allowed: false };
    return { allowed: true, senderId, chatId: ctx.chat.id.toString() };
  }

  async start(): Promise<void> {
    this.running = true;

    const me = await this.bot.api.getMe();
    this.botUsername = me.username ?? "";
    logger.info("telegram", "bot username:", this.botUsername);

    this.bot.command("start", (ctx) => ctx.reply("neoclaw ready."));

    this.bot.command("new", (ctx) => {
      const guard = this.guardInbound(ctx);
      if (!guard.allowed) return;
      this.publishInbound(guard.chatId, guard.senderId, "/new", []);
    });

    this.bot.command("help", (ctx) => {
      const guard = this.guardInbound(ctx);
      if (!guard.allowed) return;
      this.publishInbound(guard.chatId, guard.senderId, "/help", []);
    });

    this.bot.command("stop", (ctx) => {
      const guard = this.guardInbound(ctx);
      if (!guard.allowed) return;
      this.publishInbound(guard.chatId, guard.senderId, "/stop", []);
    });

    await this.refreshSkillsCache();
    this.registerDynamicSkillHandler();
    this.syncSkillCommands();
    this.watchSkillsDir();

    this.bot.on("message:text", (ctx) => {
      const guard = this.guardInbound(ctx);
      const senderId = this.senderIdFrom(ctx);
      logger.debug("telegram", "message:text", { text: ctx.message.text.slice(0, 100), chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!guard.allowed) {
        logger.debug("telegram", "blocked by allowFrom, senderId:", senderId);
        return;
      }

      if (this.isGroupChat(ctx.chat.type)) {
        const { mentioned, cleaned } = this.extractMention(ctx.message.text);
        const isReply = this.isReplyToBot(ctx);
        logger.debug("telegram", "group check", { mentioned, cleaned, isReply });
        if (!mentioned && !isReply) return;
        const content = mentioned ? cleaned : ctx.message.text;
        if (!content) return;
        this.startTyping(guard.chatId);
        this.publishInbound(guard.chatId, guard.senderId, content, []);
        return;
      }

      this.startTyping(guard.chatId);
      this.publishInbound(guard.chatId, guard.senderId, ctx.message.text, []);
    });

    this.bot.on("message:photo", async (ctx) => {
      const guard = this.guardInbound(ctx);
      const senderId = this.senderIdFrom(ctx);
      logger.debug("telegram", "message:photo", { chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!guard.allowed) {
        logger.debug("telegram", "blocked by allowFrom, senderId:", senderId);
        return;
      }
      const caption = ctx.message.caption ?? "";
      const media = await this.downloadFile(ctx.message.photo[ctx.message.photo.length - 1].file_id, "jpg");
      this.handleInboundMedia(ctx, guard.senderId, caption, media);
    });

    this.bot.on("message:document", async (ctx) => {
      const guard = this.guardInbound(ctx);
      logger.debug("telegram", "message:document", { chatType: ctx.chat.type, senderId: this.senderIdFrom(ctx), chatId: ctx.chat.id });
      if (!guard.allowed) return;
      const caption = ctx.message.caption ?? "";
      const doc = ctx.message.document;
      const media = await this.downloadFile(doc.file_id, "bin", doc.file_name ?? undefined);
      this.handleInboundMedia(ctx, guard.senderId, caption, media);
    });

    this.bot.on("message:video", async (ctx) => {
      const guard = this.guardInbound(ctx);
      logger.debug("telegram", "message:video", { chatType: ctx.chat.type, senderId: this.senderIdFrom(ctx), chatId: ctx.chat.id });
      if (!guard.allowed) return;
      const caption = ctx.message.caption ?? "";
      const media = await this.downloadFile(ctx.message.video.file_id, "mp4");
      this.handleInboundMedia(ctx, guard.senderId, caption, media);
    });

    this.bot.on("message:audio", async (ctx) => {
      const guard = this.guardInbound(ctx);
      logger.debug("telegram", "message:audio", { chatType: ctx.chat.type, senderId: this.senderIdFrom(ctx), chatId: ctx.chat.id });
      if (!guard.allowed) return;
      const caption = ctx.message.caption ?? "";
      const audio = ctx.message.audio;
      const media = await this.downloadFile(audio.file_id, "mp3", audio.file_name ?? undefined);
      this.handleInboundMedia(ctx, guard.senderId, caption, media);
    });

    this.bot.on("message:voice", async (ctx) => {
      const guard = this.guardInbound(ctx);
      logger.debug("telegram", "message:voice", { chatType: ctx.chat.type, senderId: this.senderIdFrom(ctx), chatId: ctx.chat.id });
      if (!guard.allowed) return;
      const caption = ctx.message.caption ?? "";
      const media = await this.downloadFile(ctx.message.voice.file_id, "ogg");
      this.handleInboundMedia(ctx, guard.senderId, caption, media);
    });

    await this.bot.start({ drop_pending_updates: true });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.skillsDebounce) clearTimeout(this.skillsDebounce);
    if (this.skillsWatcher) this.skillsWatcher.close();
    for (const interval of this.typingIntervals.values()) clearInterval(interval);
    this.typingIntervals.clear();
    this.bot.stop();
  }

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = msg.chatId;
    const numericChatId = Number(chatId);

    if (!msg.metadata.progress) {
      this.stopTyping(chatId);
    }

    const dedup = msg.content + msg.media.join(",");
    const last = this.lastSentContent.get(chatId);
    if (last && last.content === dedup && Date.now() - last.time <= 5000) return;
    this.lastSentContent.set(chatId, { content: dedup, time: Date.now() });

    if (msg.media.length > 0) {
      await this.sendWithMedia(numericChatId, msg);
    } else {
      await this.sendText(numericChatId, msg.content);
    }
  }

  private async sendText(chatId: number, content: string): Promise<void> {
    const chunks = mdToTelegramChunks(content, TG_MSG_LIMIT);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk.html, { parse_mode: "HTML" });
      } catch (e) {
        logger.warn("telegram", `HTML send failed, falling back to plain text, chatId=${chatId}`, e);
        try {
          await this.bot.api.sendMessage(chatId, chunk.text);
        } catch (e2) {
          logger.error("telegram", `plain text send also failed, chatId=${chatId}`, e2);
        }
      }
    }
  }

  private async sendWithMedia(chatId: number, msg: OutboundMessage): Promise<void> {
    const html = msg.content ? mdToTelegramHtml(msg.content) : "";
    const captionFits = html.length <= CAPTION_LIMIT;
    const captionOpts = (useHtml: boolean) =>
      captionFits && msg.content
        ? useHtml && html
          ? { caption: html, parse_mode: "HTML" as const }
          : { caption: msg.content }
        : {};

    if (msg.media.length === 1) {
      const path = msg.media[0];
      const source = toMediaSource(path);
      const type = mediaType(path);
      const send = async (opts: Record<string, unknown>) => {
        if (type === "photo") await this.bot.api.sendPhoto(chatId, source, opts);
        else if (type === "video") await this.bot.api.sendVideo(chatId, source, opts);
        else if (type === "audio") await this.bot.api.sendAudio(chatId, source, opts);
        else await this.bot.api.sendDocument(chatId, source, opts);
      };
      try {
        await send(captionOpts(true));
      } catch (e) {
        logger.warn("telegram", `HTML media send failed, falling back to plain text, chatId=${chatId}`, e);
        await send(captionOpts(false));
      }
    } else {
      const toGroupItem = (m: string, i: number, useHtml: boolean) => {
        const type = mediaType(m);
        const base = { media: isUrl(m) ? m : new InputFile(m) };
        const cap = i === 0 ? captionOpts(useHtml) : {};
        if (type === "video") return { type: "video" as const, ...base, ...cap };
        if (type === "audio") return { type: "audio" as const, ...base, ...cap };
        if (type === "photo") return { type: "photo" as const, ...base, ...cap };
        return { type: "document" as const, ...base, ...cap };
      };
      try {
        await this.bot.api.sendMediaGroup(chatId, msg.media.map((m, i) => toGroupItem(m, i, true)));
      } catch (e) {
        logger.warn("telegram", `HTML media group send failed, falling back to plain text, chatId=${chatId}`, e);
        await this.bot.api.sendMediaGroup(chatId, msg.media.map((m, i) => toGroupItem(m, i, false)));
      }
    }

    if (!captionFits && msg.content) {
      await this.sendText(chatId, msg.content);
    }
  }

  private handleInboundMedia(ctx: { chat: { id: number; type: string }; message?: { reply_to_message?: { from?: { id: number } } } }, senderId: string, caption: string, media: string[]): void {
    if (this.isGroupChat(ctx.chat.type)) {
      const { mentioned, cleaned } = this.extractMention(caption);
      const isReply = this.isReplyToBot(ctx);
      if (!mentioned && !isReply) return;
      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, mentioned ? cleaned : caption, media);
      return;
    }
    this.startTyping(ctx.chat.id.toString());
    this.publishInbound(ctx.chat.id.toString(), senderId, caption, media);
  }

  private publishInbound(chatId: string, senderId: string, content: string, media: string[]): void {
    const msg: InboundMessage = {
      channel: "telegram",
      senderId,
      chatId,
      content,
      timestamp: new Date(),
      media,
      metadata: {},
    };
    this.bus.publishInbound(msg);
  }

  private async refreshSkillsCache(): Promise<void> {
    const skills = await this.skillManager.getSkills();
    this.cachedSkills = [];
    for (const skill of skills) {
      const command = skill.name.replace(/-/g, "_");
      if (!/^[a-z0-9_]+$/.test(command)) {
        logger.warn("telegram", `skipping skill command /${skill.name}: contains invalid characters`);
        continue;
      }
      this.cachedSkills.push({ original: skill.name, command, description: skill.description });
    }
  }

  private registerDynamicSkillHandler(): void {
    const builtins = new Set(["start", "new", "help", "stop"]);
    this.bot.on("message:text", (ctx, next) => {
      const text = ctx.message.text;
      if (!text.startsWith("/")) return next();
      const parts = text.split(/\s+/);
      const raw = parts[0].slice(1).replace(/@.*$/, "");
      if (builtins.has(raw)) return next();
      const match = this.cachedSkills.find((s) => s.command === raw);
      if (!match) return next();
      const senderId = this.senderIdFrom(ctx);
      if (!this.isAllowed(senderId)) return;
      const args = parts.slice(1).join(" ");
      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, `/${match.original}${args ? ` ${args}` : ""}`, []);
    });
  }

  private syncSkillCommands(): void {
    const commands = [
      { command: "start", description: "Start the bot" },
      { command: "new", description: "Start a new conversation" },
      { command: "stop", description: "Stop the current agent" },
      { command: "help", description: "Show available commands" },
      ...this.cachedSkills.map((s) => ({
        command: s.command,
        description: (s.description || s.original).slice(0, 256),
      })),
    ];
    this.bot.api.setMyCommands(commands).then(() => logger.info("telegram", "commands registered:", commands.map((c) => c.command).join(", "))).catch((e) => logger.error("telegram", "setMyCommands failed:", e));
  }

  private watchSkillsDir(): void {
    const skillsDir = join(this.workspace, "skills");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
    this.skillsWatcher = watch(skillsDir, { recursive: true }, () => {
      if (this.skillsDebounce) clearTimeout(this.skillsDebounce);
      this.skillsDebounce = setTimeout(() => {
        this.refreshSkillsCache().then(() => this.syncSkillCommands());
      }, 500);
    });
  }

  updateConfig(config: TelegramConfig): void {
    this.config = config;
    logger.info("telegram", `config updated, allowFrom=${config.allowFrom.join(",")}`);
  }

  private async downloadFile(fileId: string, fallbackExt = "bin", fileName?: string): Promise<string[]> {
    try {
      const file = await this.bot.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.error("telegram", `file download failed: fileId=${fileId} status=${res.status}`);
        return [];
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = (file.file_path ?? "").split(".").pop()?.toLowerCase() ?? fallbackExt;
      const tmpDir = join(tmpdir(), "neoclaw");
      mkdirSync(tmpDir, { recursive: true });
      const name = fileName ?? `file_${crypto.randomUUID()}.${ext}`;
      const filePath = join(tmpDir, name);
      writeFileSync(filePath, buffer);
      logger.debug("telegram", `file saved: fileId=${fileId} path=${filePath}`);
      return [filePath];
    } catch (e) {
      logger.error("telegram", `file download error: fileId=${fileId}`, e);
      return [];
    }
  }

  private startTyping(chatId: string): void {
    if (this.typingIntervals.has(chatId)) return;
    const send = () => this.bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
    send();
    this.typingIntervals.set(chatId, setInterval(send, 4000));
  }

  private stopTyping(chatId: string): void {
    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }
  }
}
