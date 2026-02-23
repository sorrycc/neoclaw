import { Bot, InputFile } from "grammy";
import type { InputMediaPhoto, InputMediaDocument, InputMediaVideo, InputMediaAudio } from "grammy/types";
import { join } from "path";
import { readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { TelegramConfig } from "../config/schema.js";
import type { OutboundMessage, InboundMessage } from "../bus/types.js";

function mdToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINE_${inlineCodes.length - 1}%%`;
  });

  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");
  text = text.replace(/_(.+?)_/g, "<i>$1</i>");
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  text = text.replace(/^- /gm, "• ");

  text = text.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/%%INLINE_(\d+)%%/g, (_, i) => inlineCodes[Number(i)]);

  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CAPTION_LIMIT = 1024;

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
  private lastSentContent = new Map<string, string>();
  private botUsername = "";

  constructor(private config: TelegramConfig, private bus: MessageBus, private workspace: string) {
    this.bot = new Bot(config.token);
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

  async start(): Promise<void> {
    this.running = true;

    const me = await this.bot.api.getMe();
    this.botUsername = me.username ?? "";
    console.log("[Telegram] bot username:", this.botUsername);

    this.bot.command("start", (ctx) => ctx.reply("neoclaw ready."));

    this.bot.command("new", (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      if (!this.isAllowed(senderId)) return;
      this.publishInbound(ctx.chat.id.toString(), senderId, "/new", []);
    });

    this.bot.command("help", (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      if (!this.isAllowed(senderId)) return;
      this.publishInbound(ctx.chat.id.toString(), senderId, "/help", []);
    });

    this.bot.command("stop", (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      if (!this.isAllowed(senderId)) return;
      this.publishInbound(ctx.chat.id.toString(), senderId, "/stop", []);
    });

    this.registerSkillCommands();

    this.bot.on("message:text", (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      console.log("[Telegram] message:text", { text: ctx.message.text, chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!this.isAllowed(senderId)) {
        console.log("[Telegram] blocked by allowFrom, senderId:", senderId);
        return;
      }

      if (this.isGroupChat(ctx.chat.type)) {
        const { mentioned, cleaned } = this.extractMention(ctx.message.text);
        const isReply = this.isReplyToBot(ctx);
        console.log("[Telegram] group check", { mentioned, cleaned, isReply });
        if (!mentioned && !isReply) return;
        const content = mentioned ? cleaned : ctx.message.text;
        if (!content) return;
        this.startTyping(ctx.chat.id.toString());
        this.publishInbound(ctx.chat.id.toString(), senderId, content, []);
        return;
      }

      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, ctx.message.text, []);
    });

    this.bot.on("message:photo", async (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      console.log("[Telegram] message:photo", { chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!this.isAllowed(senderId)) {
        console.log("[Telegram] blocked by allowFrom, senderId:", senderId);
        return;
      }
      const caption = ctx.message.caption ?? "";

      const media = await this.downloadFile(ctx.message.photo[ctx.message.photo.length - 1].file_id, "jpg");

      if (this.isGroupChat(ctx.chat.type)) {
        const { mentioned, cleaned } = this.extractMention(caption);
        const isReply = this.isReplyToBot(ctx);
        console.log("[Telegram] group photo check", { mentioned, cleaned, isReply });
        if (!mentioned && !isReply) return;
        this.startTyping(ctx.chat.id.toString());
        this.publishInbound(ctx.chat.id.toString(), senderId, mentioned ? cleaned : caption, media);
        return;
      }

      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, caption, media);
    });

    this.bot.on("message:document", async (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      console.log("[Telegram] message:document", { chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!this.isAllowed(senderId)) return;
      const caption = ctx.message.caption ?? "";
      const doc = ctx.message.document;
      const media = await this.downloadFile(doc.file_id, "bin", doc.file_name ?? undefined);
      this.handleInboundMedia(ctx, senderId, caption, media);
    });

    this.bot.on("message:video", async (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      console.log("[Telegram] message:video", { chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!this.isAllowed(senderId)) return;
      const caption = ctx.message.caption ?? "";
      const media = await this.downloadFile(ctx.message.video.file_id, "mp4");
      this.handleInboundMedia(ctx, senderId, caption, media);
    });

    this.bot.on("message:audio", async (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      console.log("[Telegram] message:audio", { chatType: ctx.chat.type, senderId, chatId: ctx.chat.id });
      if (!this.isAllowed(senderId)) return;
      const caption = ctx.message.caption ?? "";
      const audio = ctx.message.audio;
      const media = await this.downloadFile(audio.file_id, "mp3", audio.file_name ?? undefined);
      this.handleInboundMedia(ctx, senderId, caption, media);
    });

    await this.bot.start({ drop_pending_updates: true });
  }

  async stop(): Promise<void> {
    this.running = false;
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
    if (this.lastSentContent.get(chatId) === dedup) return;
    this.lastSentContent.set(chatId, dedup);

    if (msg.media.length > 0) {
      await this.sendWithMedia(numericChatId, msg);
    } else {
      await this.sendText(numericChatId, msg.content);
    }
  }

  private async sendText(chatId: number, content: string): Promise<void> {
    const html = mdToTelegramHtml(content);
    try {
      await this.bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch {
      await this.bot.api.sendMessage(chatId, content);
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
      } catch {
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
      } catch {
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

  private getSkillNames(): string[] {
    const skillsDir = join(this.workspace, "skills");
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir).filter((entry) => {
      const skillPath = join(skillsDir, entry);
      return statSync(skillPath).isDirectory() && existsSync(join(skillPath, "SKILL.md"));
    });
  }

  private registerSkillCommands(): void {
    const skills = this.getSkillNames();
    const validSkills: { original: string; command: string }[] = [];
    for (const name of skills) {
      const command = name.replace(/-/g, "_");
      if (!/^[a-z0-9_]+$/.test(command)) {
        console.warn(`[Telegram] skipping skill command /${name}: contains invalid characters`);
        continue;
      }
      validSkills.push({ original: name, command });
    }
    for (const { original, command } of validSkills) {
      this.bot.command(command, (ctx) => {
        const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
        if (!this.isAllowed(senderId)) return;
        const args = ctx.match ? ` ${ctx.match}` : "";
        this.startTyping(ctx.chat.id.toString());
        this.publishInbound(ctx.chat.id.toString(), senderId, `/${original}${args}`, []);
      });
    }
    const commands = [
      { command: "start", description: "Start the bot" },
      { command: "new", description: "Start a new conversation" },
      { command: "stop", description: "Stop the current agent" },
      { command: "help", description: "Show available commands" },
      ...validSkills.map((s) => ({ command: s.command, description: s.original })),
    ];
    this.bot.api.setMyCommands(commands).then(() => console.log("[Telegram] commands registered:", commands.map(c => c.command).join(", "))).catch((e) => console.error("[Telegram] setMyCommands failed:", e));
  }

  private async downloadFile(fileId: string, fallbackExt = "bin", fileName?: string): Promise<string[]> {
    try {
      const file = await this.bot.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error("[Telegram] file download failed:", res.status);
        return [];
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = (file.file_path ?? "").split(".").pop()?.toLowerCase() ?? fallbackExt;
      const tmpDir = join(tmpdir(), "neoclaw");
      mkdirSync(tmpDir, { recursive: true });
      const name = fileName ?? `file_${crypto.randomUUID()}.${ext}`;
      const filePath = join(tmpDir, name);
      writeFileSync(filePath, buffer);
      console.log("[Telegram] file saved:", filePath);
      return [filePath];
    } catch (e) {
      console.error("[Telegram] file download error:", e);
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
