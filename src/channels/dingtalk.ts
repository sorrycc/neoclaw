import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import axios from "axios";
import FormData from "form-data";
import { createReadStream, mkdirSync, writeFileSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { DingtalkConfig } from "../config/schema.js";
import type { OutboundMessage, InboundMessage } from "../bus/types.js";
import { logger } from "../logger.js";

// --- Token cache ---

interface TokenCache {
  accessToken: string;
  expiry: number;
}

let tokenCache: TokenCache | null = null;

async function getAccessToken(config: DingtalkConfig): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiry > now + 60_000) {
    return tokenCache.accessToken;
  }
  const res = await axios.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    appKey: config.clientId,
    appSecret: config.clientSecret,
  });
  tokenCache = {
    accessToken: res.data.accessToken,
    expiry: now + res.data.expireIn * 1000,
  };
  return tokenCache.accessToken;
}

// --- Media helpers ---

type DingTalkMediaType = "image" | "voice" | "video" | "file";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);
const VOICE_EXTS = new Set([".mp3", ".amr", ".wav", ".ogg"]);
const VIDEO_EXTS = new Set([".mp4", ".avi", ".mov"]);

function detectMediaType(filePath: string): DingTalkMediaType {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VOICE_EXTS.has(ext)) return "voice";
  if (VIDEO_EXTS.has(ext)) return "video";
  return "file";
}

const MEDIA_TYPE_EXT: Record<DingTalkMediaType, string> = {
  image: ".jpg",
  voice: ".mp3",
  video: ".mp4",
  file: ".bin",
};

async function downloadMedia(config: DingtalkConfig, downloadCode: string, mediaType: DingTalkMediaType = "file"): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    const res = await axios.post(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode, robotCode: config.robotCode || config.clientId },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
    const downloadUrl = res.data?.downloadUrl;
    if (!downloadUrl) return null;

    const fileRes = await axios.get(downloadUrl, { responseType: "arraybuffer" });
    const tmpDir = join(tmpdir(), "neoclaw");
    mkdirSync(tmpDir, { recursive: true });
    // Extract extension from URL path, fall back to mediaType default
    let ext = MEDIA_TYPE_EXT[mediaType];
    try {
      const urlExt = extname(new URL(downloadUrl).pathname).toLowerCase();
      if (urlExt) ext = urlExt;
    } catch {}
    const filePath = join(tmpDir, `dt_${randomUUID()}${ext}`);
    writeFileSync(filePath, Buffer.from(fileRes.data));
    logger.debug("dingtalk", `media downloaded: ${filePath}`);
    return filePath;
  } catch (e) {
    logger.error("dingtalk", "media download failed:", e);
    return null;
  }
}

async function uploadMedia(config: DingtalkConfig, mediaPath: string, mediaType: DingTalkMediaType): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    const form = new FormData();
    form.append("media", createReadStream(mediaPath), { filename: basename(mediaPath) });
    const res = await axios.post(
      `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`,
      form,
      { headers: form.getHeaders(), maxBodyLength: Infinity },
    );
    if (res.data?.errcode === 0 && res.data?.media_id) {
      return res.data.media_id;
    }
    logger.error("dingtalk", "media upload failed:", res.data);
    return null;
  } catch (e) {
    logger.error("dingtalk", "media upload error:", e);
    return null;
  }
}

// --- Message content extraction ---

interface DingTalkInboundMessage {
  msgId?: string;
  msgtype?: string;
  text?: { content?: string };
  content?: { downloadCode?: string; recognition?: string; fileName?: string; richText?: any[] };
  conversationId?: string;
  conversationType?: string;
  senderId?: string;
  senderNick?: string;
  sessionWebhook?: string;
  robotCode?: string;
}

function extractContent(data: DingTalkInboundMessage): { text: string; downloadCode?: string; mediaType?: DingTalkMediaType } {
  const msgtype = data.msgtype || "text";
  if (msgtype === "text") return { text: data.text?.content?.trim() || "" };
  if (msgtype === "picture") return { text: "", downloadCode: data.content?.downloadCode, mediaType: "image" };
  if (msgtype === "audio") return { text: data.content?.recognition || "", downloadCode: data.content?.downloadCode, mediaType: "voice" };
  if (msgtype === "video") return { text: "", downloadCode: data.content?.downloadCode, mediaType: "video" };
  if (msgtype === "file") return { text: data.content?.fileName || "", downloadCode: data.content?.downloadCode, mediaType: "file" };
  if (msgtype === "richText") {
    const parts = data.content?.richText || [];
    let text = "";
    let downloadCode: string | undefined;
    for (const part of parts) {
      if (part.text) text += part.text;
      if (part.type === "picture" && part.downloadCode && !downloadCode) downloadCode = part.downloadCode;
    }
    return { text: text.trim(), downloadCode, mediaType: downloadCode ? "image" : undefined };
  }
  return { text: data.text?.content?.trim() || `[${msgtype}]` };
}

// --- Session webhook store ---

interface SessionInfo {
  webhook: string;
  expiry: number;
}

const SESSION_TTL = 25 * 60 * 1000; // 25 min (webhook valid ~30 min, use 25 for safety)

// --- Main channel class ---

export class DingtalkChannel implements Channel {
  readonly name = "dingtalk" as const;
  private client: DWClient | null = null;
  private sessions = new Map<string, SessionInfo>();
  private processedMsgs = new Map<string, number>();
  private lastInbound = new Map<string, { content: string; time: number }>();
  private lastSentContent = new Map<string, { content: string; time: number }>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: DingtalkConfig, private bus: MessageBus) {}

  private isAllowed(senderId: string): boolean {
    if (this.config.allowFrom.length === 0) return true;
    return this.config.allowFrom.some((a) => senderId.includes(a));
  }

  private isDuplicate(msgId: string): boolean {
    if (this.processedMsgs.has(msgId)) return true;
    this.processedMsgs.set(msgId, Date.now());
    return false;
  }

  async start(): Promise<void> {
    this.client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: false,
      keepAlive: true,
    });

    this.dedupCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, t] of this.processedMsgs) {
        if (t < cutoff) this.processedMsgs.delete(k);
      }
      for (const [k, s] of this.sessions) {
        if (s.expiry < Date.now()) this.sessions.delete(k);
      }
      const inboundCutoff = Date.now() - 10_000;
      for (const [k, v] of this.lastInbound) {
        if (v.time < inboundCutoff) this.lastInbound.delete(k);
      }
      for (const [k, v] of this.lastSentContent) {
        if (v.time < inboundCutoff) this.lastSentContent.delete(k);
      }
    }, 60_000);

    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      const messageId = res.headers?.messageId;
      try {
        if (messageId) {
          this.client!.socketCallBackResponse(messageId, { success: true });
        }

        const data: DingTalkInboundMessage = JSON.parse(res.data);
        const msgId = data.msgId || messageId;
        if (msgId && this.isDuplicate(msgId)) {
          logger.debug("dingtalk", `dedup skip: ${msgId}`);
          return;
        }

        const senderId = data.senderId || "";
        if (!this.isAllowed(senderId)) {
          logger.debug("dingtalk", `blocked senderId: ${senderId}`);
          return;
        }

        // Store session webhook for replies
        const chatId = data.conversationId || "";
        if (data.sessionWebhook) {
          this.sessions.set(chatId, { webhook: data.sessionWebhook, expiry: Date.now() + SESSION_TTL });
        }

        // Extract content and handle media
        const { text, downloadCode, mediaType } = extractContent(data);

        // Content-based dedup: catches duplicates when msgId differs across retries
        const dedupKey = `${senderId}:${chatId}:${text}`;
        const lastInbound = this.lastInbound.get(dedupKey);
        if (lastInbound && Date.now() - lastInbound.time < 5000) {
          logger.debug("dingtalk", `content dedup skip: ${dedupKey.slice(0, 80)}`);
          return;
        }
        this.lastInbound.set(dedupKey, { content: text, time: Date.now() });

        const media: string[] = [];
        if (downloadCode) {
          const path = await downloadMedia(this.config, downloadCode, mediaType || "file");
          if (path) media.push(path);
        }

        const isGroup = data.conversationType === "2";
        logger.debug("dingtalk", `inbound: ${isGroup ? "group" : "dm"} from=${senderId} chat=${chatId} text=${text.slice(0, 80)}`);

        const msg: InboundMessage = {
          channel: "dingtalk",
          senderId,
          chatId,
          content: text,
          timestamp: new Date(),
          media,
          metadata: { isGroup, senderNick: data.senderNick },
        };
        this.bus.publishInbound(msg);
      } catch (err) {
        logger.error("dingtalk", "inbound handler error:", err);
      }
    });

    await this.client.connect();
    logger.info("dingtalk", "stream client connected");
  }

  async stop(): Promise<void> {
    if (this.dedupCleanupTimer) clearInterval(this.dedupCleanupTimer);
    if (this.client) {
      try { this.client.disconnect(); } catch {}
    }
    this.sessions.clear();
    this.processedMsgs.clear();
    this.lastInbound.clear();
    this.lastSentContent.clear();
    logger.info("dingtalk", "stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = msg.chatId;

    // Outbound dedup: skip if same content was sent to same chatId within 5s
    const dedup = msg.content + msg.media.join(",");
    const last = this.lastSentContent.get(chatId);
    if (last && last.content === dedup && Date.now() - last.time <= 5000) return;
    this.lastSentContent.set(chatId, { content: dedup, time: Date.now() });

    // Handle media first
    if (msg.media.length > 0) {
      for (const mediaPath of msg.media) {
        await this.sendMedia(chatId, mediaPath);
      }
    }

    // Send text content
    if (msg.content) {
      await this.sendText(chatId, msg.content);
    }
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    // Try session webhook first
    const session = this.sessions.get(chatId);
    if (session && session.expiry > Date.now()) {
      try {
        const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
        const body = hasMarkdown
          ? { msgtype: "markdown", markdown: { title: text.split("\n")[0].replace(/^[#*\s\->]+/, "").slice(0, 20) || "消息", text } }
          : { msgtype: "text", text: { content: text } };
        await axios.post(session.webhook, body);
        return;
      } catch (e) {
        logger.warn("dingtalk", `session webhook failed for chatId=${chatId}, trying proactive`, e);
      }
    }

    // Fallback to proactive API
    await this.sendProactive(chatId, text);
  }

  private async sendProactive(chatId: string, text: string): Promise<void> {
    const token = await getAccessToken(this.config);
    const isGroup = chatId.startsWith("cid");
    const robotCode = this.config.robotCode || this.config.clientId;

    const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
    const msgKey = hasMarkdown ? "sampleMarkdown" : "sampleText";
    const msgParam = hasMarkdown
      ? JSON.stringify({ title: text.split("\n")[0].replace(/^[#*\s\->]+/, "").slice(0, 20) || "消息", text })
      : JSON.stringify({ content: text });

    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

    const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
    if (isGroup) {
      payload.openConversationId = chatId;
    } else {
      payload.userIds = [chatId];
    }

    await axios.post(url, payload, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
  }

  private async sendMedia(chatId: string, mediaPath: string): Promise<void> {
    const mediaType = detectMediaType(mediaPath);

    // Try session webhook with media upload
    const session = this.sessions.get(chatId);
    if (session && session.expiry > Date.now()) {
      const mediaId = await uploadMedia(this.config, mediaPath, mediaType);
      if (mediaId) {
        try {
          const typeMap: Record<DingTalkMediaType, any> = {
            image: { msgtype: "image", image: { media_id: mediaId } },
            voice: { msgtype: "voice", voice: { media_id: mediaId } },
            video: { msgtype: "video", video: { media_id: mediaId } },
            file: { msgtype: "file", file: { media_id: mediaId } },
          };
          await axios.post(session.webhook, typeMap[mediaType]);
          return;
        } catch (e) {
          logger.warn("dingtalk", `session media send failed for chatId=${chatId}, trying proactive`, e);
        }
      }
    }

    // Fallback to proactive media send
    const mediaId = await uploadMedia(this.config, mediaPath, mediaType);
    if (!mediaId) {
      logger.error("dingtalk", `media upload failed, skipping: ${mediaPath}`);
      return;
    }

    const token = await getAccessToken(this.config);
    const isGroup = chatId.startsWith("cid");
    const robotCode = this.config.robotCode || this.config.clientId;

    let msgKey: string;
    let msgParam: string;
    if (mediaType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else if (mediaType === "voice") {
      msgKey = "sampleAudio";
      msgParam = JSON.stringify({ mediaId, duration: "0" });
    } else {
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName: basename(mediaPath), fileType: extname(mediaPath).slice(1) || "file" });
    }

    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

    const payload: Record<string, unknown> = { robotCode, msgKey, msgParam };
    if (isGroup) {
      payload.openConversationId = chatId;
    } else {
      payload.userIds = [chatId];
    }

    await axios.post(url, payload, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
  }

  updateConfig(config: DingtalkConfig): void {
    this.config = config;
    logger.info("dingtalk", `config updated, allowFrom=${config.allowFrom.join(",")}`);
  }
}
