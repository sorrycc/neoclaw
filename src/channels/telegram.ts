import { Bot, InputFile } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
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

      const media = await this.downloadPhoto(ctx.message.photo);

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

    if (msg.media.length === 1) {
      const source = toMediaSource(msg.media[0]);
      try {
        await this.bot.api.sendPhoto(chatId, source, {
          ...(captionFits && html ? { caption: html, parse_mode: "HTML" } : {}),
        });
      } catch {
        await this.bot.api.sendPhoto(chatId, source, {
          ...(captionFits && msg.content ? { caption: msg.content } : {}),
        });
      }
    } else {
      const group: InputMediaPhoto[] = msg.media.map((m, i) => ({
        type: "photo" as const,
        media: isUrl(m) ? m : new InputFile(m),
        ...(i === 0 && captionFits && html ? { caption: html, parse_mode: "HTML" as const } : {}),
      }));
      try {
        await this.bot.api.sendMediaGroup(chatId, group);
      } catch {
        const fallback: InputMediaPhoto[] = msg.media.map((m, i) => ({
          type: "photo" as const,
          media: isUrl(m) ? m : new InputFile(m),
          ...(i === 0 && captionFits && msg.content ? { caption: msg.content } : {}),
        }));
        await this.bot.api.sendMediaGroup(chatId, fallback);
      }
    }

    if (!captionFits && msg.content) {
      await this.sendText(chatId, msg.content);
    }
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

  private async downloadPhoto(photos: { file_id: string }[]): Promise<string[]> {
    try {
      const photo = photos[photos.length - 1];
      const file = await this.bot.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error("[Telegram] photo download failed:", res.status);
        return [];
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = (file.file_path ?? "").split(".").pop()?.toLowerCase() ?? "jpg";
      const tmpDir = join(tmpdir(), "neoclaw");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `photo_${crypto.randomUUID()}.${ext}`);
      writeFileSync(filePath, buffer);
      console.log("[Telegram] photo saved:", filePath);
      return [filePath];
    } catch (e) {
      console.error("[Telegram] photo download error:", e);
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
