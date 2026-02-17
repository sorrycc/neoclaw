import { Bot } from "grammy";
import { join } from "path";
import { readdirSync, existsSync, statSync } from "fs";
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

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private bot: Bot;
  private running = false;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private progressMessages = new Map<string, number>();

  constructor(private config: TelegramConfig, private bus: MessageBus, private workspace: string) {
    this.bot = new Bot(config.token);
  }

  private isAllowed(senderId: string): boolean {
    if (this.config.allowFrom.length === 0) return true;
    return this.config.allowFrom.some((a) => senderId.includes(a));
  }

  async start(): Promise<void> {
    this.running = true;

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

    this.registerSkillCommands();

    this.bot.on("message:text", (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      if (!this.isAllowed(senderId)) return;
      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, ctx.message.text, []);
    });

    this.bot.on("message:photo", async (ctx) => {
      const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
      if (!this.isAllowed(senderId)) return;
      const caption = ctx.message.caption ?? "";
      this.startTyping(ctx.chat.id.toString());
      this.publishInbound(ctx.chat.id.toString(), senderId, caption, []);
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
    const isProgress = !!msg.metadata.progress;
    const chatId = msg.chatId;
    const numericChatId = Number(chatId);
    const html = mdToTelegramHtml(msg.content);

    console.log(`[tg:send] chatId=${chatId} isProgress=${isProgress} content=${JSON.stringify(msg.content).slice(0, 80)} progressMap=${JSON.stringify([...this.progressMessages.entries()])}`);

    if (isProgress) {
      const existingMsgId = this.progressMessages.get(chatId);
      console.log(`[tg:send:progress] existingMsgId=${existingMsgId}`);
      if (existingMsgId) {
        try {
          await this.bot.api.editMessageText(numericChatId, existingMsgId, html, { parse_mode: "HTML" });
          console.log(`[tg:send:progress] edited ${existingMsgId}`);
          return;
        } catch {
          try {
            await this.bot.api.editMessageText(numericChatId, existingMsgId, msg.content);
            console.log(`[tg:send:progress] edited ${existingMsgId} (plain)`);
            return;
          } catch {}
        }
      }
      try {
        const sent = await this.bot.api.sendMessage(numericChatId, html, { parse_mode: "HTML" });
        this.progressMessages.set(chatId, sent.message_id);
        console.log(`[tg:send:progress] sent new msg ${sent.message_id}`);
      } catch {
        const sent = await this.bot.api.sendMessage(numericChatId, msg.content);
        this.progressMessages.set(chatId, sent.message_id);
        console.log(`[tg:send:progress] sent new msg ${sent.message_id} (plain)`);
      }
      return;
    }

    this.stopTyping(chatId);
    const prevMsgId = this.progressMessages.get(chatId);
    this.progressMessages.delete(chatId);
    console.log(`[tg:send:final] prevMsgId=${prevMsgId}`);
    if (prevMsgId) {
      try {
        await this.bot.api.editMessageText(numericChatId, prevMsgId, html, { parse_mode: "HTML" });
        console.log(`[tg:send:final] edited ${prevMsgId}`);
        return;
      } catch (err: any) {
        if (err?.error_code === 400 && err?.description?.includes("message is not modified")) {
          console.log(`[tg:send:final] already up-to-date ${prevMsgId}`);
          return;
        }
        console.log(`[tg:send:final] edit failed:`, err);
        try {
          await this.bot.api.editMessageText(numericChatId, prevMsgId, msg.content);
          console.log(`[tg:send:final] edited ${prevMsgId} (plain)`);
          return;
        } catch (err2: any) {
          if (err2?.error_code === 400 && err2?.description?.includes("message is not modified")) {
            console.log(`[tg:send:final] already up-to-date ${prevMsgId} (plain)`);
            return;
          }
          console.log(`[tg:send:final] edit plain failed:`, err2);
        }
      }
    }
    try {
      await this.bot.api.sendMessage(numericChatId, html, { parse_mode: "HTML" });
      console.log(`[tg:send:final] sent new msg (fallback)`);
    } catch {
      await this.bot.api.sendMessage(numericChatId, msg.content);
      console.log(`[tg:send:final] sent new msg (plain fallback)`);
    }
  }

  private publishInbound(chatId: string, senderId: string, content: string, media: string[]): void {
    this.progressMessages.delete(chatId);
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
    for (const name of skills) {
      this.bot.command(name, (ctx) => {
        const senderId = `${ctx.from?.id}|${ctx.from?.username ?? ""}`;
        if (!this.isAllowed(senderId)) return;
        const args = ctx.match ? ` ${ctx.match}` : "";
        this.startTyping(ctx.chat.id.toString());
        this.publishInbound(ctx.chat.id.toString(), senderId, `/${name}${args}`, []);
      });
    }
    const commands = [
      { command: "start", description: "Start the bot" },
      { command: "new", description: "Start a new conversation" },
      { command: "help", description: "Show available commands" },
      ...skills.map((s) => ({ command: s, description: s })),
    ];
    this.bot.api.setMyCommands(commands).catch(() => {});
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
