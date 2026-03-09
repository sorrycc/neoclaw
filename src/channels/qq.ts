import { createHash } from "crypto";
import { basename, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage, OutboundMessage } from "../bus/types.js";
import type { QQConfig } from "../config/schema.js";
import { logger } from "../logger.js";

type QQScene = "private" | "group" | "channel";
type QQGatewayPayload = { op: number; d?: any; s?: number; t?: string };
type QQTarget = { scene: QQScene; id: string };
type PersistedDedup = Record<string, number>;
type UploadMediaResponse = { file_uuid?: string; file_info?: string; ttl?: number; id?: string; message?: string; code?: number };

type QQC2CMessageEvent = {
  id?: string;
  content?: string;
  timestamp?: string;
  attachments?: Array<{ url?: string; content_type?: string; filename?: string }>;
  author?: {
    user_openid?: string;
    union_openid?: string;
    id?: string;
  };
};

type QQGroupMessageEvent = {
  id?: string;
  content?: string;
  timestamp?: string;
  group_id?: string;
  group_openid?: string;
  attachments?: Array<{ url?: string; content_type?: string; filename?: string }>;
  author?: {
    id?: string;
    member_openid?: string;
  };
};

type QQGuildMessageEvent = {
  id?: string;
  content?: string;
  timestamp?: string;
  guild_id?: string;
  channel_id?: string;
  attachments?: Array<{ url?: string; content_type?: string; filename?: string }>;
  author?: {
    id?: string;
    username?: string;
  };
};

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const DEFAULT_WS_INTENTS = (1 << 30) | (1 << 12) | (1 << 25);
const DEFAULT_WS_RECONNECT_BASE_MS = 1000;
const DEFAULT_WS_RECONNECT_MAX_MS = 30_000;
const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_FLUSH_DELAY_MS = 2_000;
const TEXT_LIMIT = 1800;
const OUTBOUND_DEDUP_WINDOW_MS = 5000;
const READY_TIMEOUT_MS = 15_000;

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "aac", "m4a", "flac", "silk", "amr"]);

enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function stripMentions(input: string): string {
  return (input || "")
    .replace(/<@!?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(input: string, limit: number): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks.filter(Boolean);
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function fileExt(value: string): string {
  const input = isRemoteUrl(value) ? new URL(value).pathname : value;
  const idx = input.lastIndexOf(".");
  return idx >= 0 ? input.slice(idx + 1).toLowerCase() : "";
}

function inferMediaFileType(value: string): MediaFileType {
  if (isDataUrl(value)) {
    const mime = value.slice(5, value.indexOf(";"));
    if (mime.startsWith("image/")) return MediaFileType.IMAGE;
    if (mime.startsWith("video/")) return MediaFileType.VIDEO;
    if (mime.startsWith("audio/")) return MediaFileType.VOICE;
    return MediaFileType.FILE;
  }
  const ext = fileExt(value);
  if (IMAGE_EXTS.has(ext)) return MediaFileType.IMAGE;
  if (VIDEO_EXTS.has(ext)) return MediaFileType.VIDEO;
  if (AUDIO_EXTS.has(ext)) return MediaFileType.VOICE;
  return MediaFileType.FILE;
}

function parseDataUrl(value: string): { mime: string; base64: string } {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL format");
  return { mime: match[1], base64: match[2] };
}

function readLocalFileAsBase64(value: string): { base64: string; fileName: string } {
  const path = value.trim();
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`qq media file not found: ${path}`);
  }
  return {
    base64: readFileSync(path).toString("base64"),
    fileName: basename(path),
  };
}

async function jsonRequest<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const raw = await res.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!res.ok) {
    const err = typeof data === "object" && data ? data.message || JSON.stringify(data) : String(data || res.statusText);
    throw new Error(err);
  }
  if (data && typeof data === "object" && typeof data.code === "number" && data.code !== 0) {
    throw new Error(data.message || JSON.stringify(data));
  }
  return data as T;
}

export function validateQQConfig(config: QQConfig): string[] {
  const errors: string[] = [];
  if (!config.appId.trim()) errors.push("appId is required");
  if (!config.clientSecret.trim()) errors.push("clientSecret is required");
  const intents = asPositiveInt(config.wsIntentMask, DEFAULT_WS_INTENTS);
  if (intents <= 0) errors.push("wsIntentMask must be a positive integer");
  const base = asPositiveInt(config.wsReconnectBaseMs, DEFAULT_WS_RECONNECT_BASE_MS);
  const max = asPositiveInt(config.wsReconnectMaxMs, DEFAULT_WS_RECONNECT_MAX_MS);
  if (base > max) errors.push("wsReconnectBaseMs cannot be greater than wsReconnectMaxMs");
  if (config.dedupPersist && !config.dedupFile?.trim()) errors.push("dedupFile is required when dedupPersist=true");
  return errors;
}

export function resolveQQTarget(chatId: string): QQTarget {
  const raw = chatId.trim();
  if (!raw) throw new Error("qq send failed: empty target");
  const normalized = raw.replace(/^(qq|qqbot):/i, "").trim();
  const idx = normalized.indexOf(":");
  if (idx > 0) {
    const prefix = normalized.slice(0, idx).toLowerCase();
    const id = normalized.slice(idx + 1).trim();
    if (!id) throw new Error("qq send failed: empty target id");
    if (prefix === "private" || prefix === "c2c" || prefix === "dm" || prefix === "user") return { scene: "private", id };
    if (prefix === "group") return { scene: "group", id };
    if (prefix === "channel" || prefix === "guild") return { scene: "channel", id };
  }
  if (/^[0-9a-fA-F-]{16,}$/.test(normalized)) return { scene: "private", id: normalized };
  throw new Error(`qq send failed: unsupported target format \"${chatId}\"`);
}

export function mapQQDispatchToInbound(eventType: string, payload: unknown, config: QQConfig): InboundMessage | null {
  if (eventType === "C2C_MESSAGE_CREATE") {
    const event = payload as QQC2CMessageEvent;
    const sender = event.author?.user_openid || event.author?.union_openid || event.author?.id || "";
    if (!sender) return null;
    if (config.allowFrom.length > 0 && !config.allowFrom.some((entry) => sender.includes(entry))) return null;
    return {
      channel: "qq",
      senderId: `${sender}|`,
      chatId: `qq:private:${sender}`,
      content: stripMentions(event.content || ""),
      timestamp: new Date(event.timestamp || Date.now()),
      media: [],
      metadata: {
        sourceMessageId: event.id || "",
        rawEventType: eventType,
        scene: "private",
        originChannel: "qq",
        originChatId: `qq:private:${sender}`,
      },
    };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    const event = payload as QQGroupMessageEvent;
    const sender = event.author?.member_openid || event.author?.id || "";
    const groupId = event.group_openid || event.group_id || "";
    if (!sender || !groupId) return null;
    if (config.allowFrom.length > 0 && !config.allowFrom.some((entry) => sender.includes(entry))) return null;
    return {
      channel: "qq",
      senderId: `${sender}|`,
      chatId: `qq:group:${groupId}`,
      content: stripMentions(event.content || ""),
      timestamp: new Date(event.timestamp || Date.now()),
      media: [],
      metadata: {
        sourceMessageId: event.id || "",
        rawEventType: eventType,
        scene: "group",
        originChannel: "qq",
        originChatId: `qq:group:${groupId}`,
      },
    };
  }

  if (eventType === "AT_MESSAGE_CREATE") {
    const event = payload as QQGuildMessageEvent;
    const sender = event.author?.id || "";
    const channelId = event.channel_id || "";
    if (!sender || !channelId) return null;
    if (config.allowFrom.length > 0 && !config.allowFrom.some((entry) => sender.includes(entry))) return null;
    return {
      channel: "qq",
      senderId: `${sender}|${event.author?.username || ""}`,
      chatId: `qq:channel:${channelId}`,
      content: stripMentions(event.content || ""),
      timestamp: new Date(event.timestamp || Date.now()),
      media: [],
      metadata: {
        sourceMessageId: event.id || "",
        rawEventType: eventType,
        scene: "channel",
        guildId: event.guild_id || "",
        originChannel: "qq",
        originChatId: `qq:channel:${channelId}`,
      },
    };
  }

  if (eventType === "DIRECT_MESSAGE_CREATE") {
    const event = payload as QQGuildMessageEvent;
    const sender = event.author?.id || "";
    if (!sender) return null;
    if (config.allowFrom.length > 0 && !config.allowFrom.some((entry) => sender.includes(entry))) return null;
    return {
      channel: "qq",
      senderId: `${sender}|${event.author?.username || ""}`,
      chatId: `qq:private:${sender}`,
      content: stripMentions(event.content || ""),
      timestamp: new Date(event.timestamp || Date.now()),
      media: [],
      metadata: {
        sourceMessageId: event.id || "",
        rawEventType: eventType,
        scene: "private",
        guildId: event.guild_id || "",
        originChannel: "qq",
        originChatId: `qq:private:${sender}`,
      },
    };
  }

  return null;
}

function buildTextBody(content: string, replyTo?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content,
    msg_type: 0,
    msg_seq: Math.floor(Math.random() * 65535),
  };
  if (replyTo) body.msg_id = replyTo;
  return body;
}

function buildMediaBody(fileInfo: string, replyTo?: string, content?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: Math.floor(Math.random() * 65535),
  };
  if (replyTo) body.msg_id = replyTo;
  if (content) body.content = content;
  return body;
}

export class QQChannel implements Channel {
  readonly name = "qq" as const;
  private running = false;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private tokenCache: { token: string; expiry: number; appId: string } | null = null;
  private sessionId = "";
  private lastSeq: number | null = null;
  private processed = new Map<string, number>();
  private lastSentContent = new Map<string, { content: string; time: number }>();
  private dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: QQConfig, private bus: MessageBus) {}

  async start(): Promise<void> {
    const errors = validateQQConfig(this.config);
    if (errors.length > 0) throw new Error(`invalid qq config: ${errors.join("; ")}`);
    this.running = true;
    await this.loadPersistentDedup();
    this.startCleanup();
    await this.connect(true);
    logger.info("qq", `channel started (dedup=${this.config.dedupPersist ? "memory+disk" : "memory"})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.tokenCache = null;
    this.sessionId = "";
    this.lastSeq = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.dedupFlushTimer) clearTimeout(this.dedupFlushTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.cleanupTimer = null;
    this.dedupFlushTimer = null;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    await this.flushDedupToDisk(true);
    this.processed.clear();
    this.lastSentContent.clear();
    logger.info("qq", "stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.appId || !this.config.clientSecret) throw new Error("qq appId/clientSecret is required");
    if (msg.metadata.progress) return;

    const target = resolveQQTarget(msg.chatId);
    const dedupKey = createHash("sha1")
      .update(JSON.stringify({ target, content: msg.content, media: msg.media, replyTo: msg.replyTo || "" }))
      .digest("hex");
    const last = this.lastSentContent.get(dedupKey);
    if (last && Date.now() - last.time <= OUTBOUND_DEDUP_WINDOW_MS) return;
    this.lastSentContent.set(dedupKey, { content: msg.content, time: Date.now() });

    const token = await this.getAccessToken();
    if (msg.media.length > 0) {
      await this.sendWithMedia(token, target, msg);
      return;
    }

    const chunks = chunkText(msg.content, TEXT_LIMIT);
    for (const chunk of chunks.length > 0 ? chunks : [""]) {
      await this.sendText(token, target, chunk, msg.replyTo);
    }
  }

  updateConfig(config: QQConfig): void {
    const errors = validateQQConfig(config);
    if (errors.length > 0) {
      logger.error("qq", `ignoring invalid config update: ${errors.join("; ")}`);
      return;
    }
    const prev = this.config;
    this.config = config;
    this.tokenCache = null;
    if (this.running && config.dedupPersist && (!prev.dedupPersist || prev.dedupFile !== config.dedupFile)) {
      void this.loadPersistentDedup();
    }
    if (this.running) {
      try { this.ws?.close(4000, "config updated"); } catch {}
    }
  }

  private async connect(expectReady: boolean): Promise<void> {
    if (!this.running) return;
    const accessToken = await this.getAccessToken();
    const gatewayUrl = await this.getGatewayUrl(accessToken);
    logger.info("qq", `websocket connecting to ${gatewayUrl}`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyTimer: ReturnType<typeof setTimeout> | null = null;
      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (readyTimer) clearTimeout(readyTimer);
        err ? reject(err) : resolve();
      };

      if (expectReady) readyTimer = setTimeout(() => finish(new Error("qq websocket ready timeout")), READY_TIMEOUT_MS);

      ws.onopen = () => {
        if (!expectReady) finish();
      };

      ws.onerror = () => {
        if (expectReady) finish(new Error("qq websocket error before ready"));
      };

      ws.onclose = (event) => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.ws === ws) this.ws = null;
        if ([4006, 4007, 4009].includes(event.code)) {
          this.sessionId = "";
          this.lastSeq = null;
        }
        if (expectReady && !settled) finish(new Error(`qq websocket closed before ready (code=${event.code})`));
        if (this.running) this.scheduleReconnect();
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? Buffer.from(event.data).toString("utf-8")
            : String(event.data);
        let payload: QQGatewayPayload;
        try {
          payload = JSON.parse(raw) as QQGatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") this.lastSeq = payload.s;

        switch (payload.op) {
          case 10: {
            const heartbeatInterval = asPositiveInt(payload.d?.heartbeat_interval, 30_000);
            if (this.sessionId && this.lastSeq !== null) {
              ws.send(JSON.stringify({ op: 6, d: { token: `QQBot ${accessToken}`, session_id: this.sessionId, seq: this.lastSeq } }));
            } else {
              ws.send(JSON.stringify({
                op: 2,
                d: { token: `QQBot ${accessToken}`, intents: asPositiveInt(this.config.wsIntentMask, DEFAULT_WS_INTENTS), shard: [0, 1] },
              }));
            }
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            }, heartbeatInterval);
            break;
          }
          case 0: {
            if (payload.t === "READY") {
              this.sessionId = String(payload.d?.session_id || "");
              this.reconnectAttempt = 0;
              finish();
              return;
            }
            if (payload.t === "RESUMED") {
              this.reconnectAttempt = 0;
              finish();
              return;
            }
            if (payload.t) {
              const inbound = mapQQDispatchToInbound(payload.t, payload.d, this.config);
              if (inbound) {
                const dedupKey = `in:${String(inbound.metadata.sourceMessageId || "")}`;
                if (dedupKey !== "in:" && this.isDuplicate(dedupKey)) return;
                void this.bus.publishInbound(inbound);
              }
            }
            break;
          }
          case 7:
            try { ws.close(4200, "server reconnect"); } catch {}
            break;
          case 9:
            this.sessionId = "";
            this.lastSeq = null;
            try { ws.close(4201, "invalid session"); } catch {}
            break;
          case 11:
          default:
            break;
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.nextReconnectDelay(this.reconnectAttempt++);
    logger.warn("qq", `websocket disconnected, reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      void this.connect(false).catch((err) => {
        logger.error("qq", "reconnect failed:", err);
        if (this.running) this.scheduleReconnect();
      });
    }, delay);
  }

  private nextReconnectDelay(attempt: number): number {
    const base = asPositiveInt(this.config.wsReconnectBaseMs, DEFAULT_WS_RECONNECT_BASE_MS);
    const max = asPositiveInt(this.config.wsReconnectMaxMs, DEFAULT_WS_RECONNECT_MAX_MS);
    const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
    const jitter = Math.floor(Math.random() * Math.max(200, Math.floor(exp * 0.2)));
    return Math.min(max, exp + jitter);
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.appId === this.config.appId && Date.now() < this.tokenCache.expiry - 5 * 60 * 1000) {
      return this.tokenCache.token;
    }
    const data = await jsonRequest<{ access_token?: string; expires_in?: number; message?: string }>(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.clientSecret }),
    });
    if (!data.access_token) throw new Error(`qq auth failed: ${data.message || "missing access_token"}`);
    this.tokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in || 7200) * 1000, appId: this.config.appId };
    return data.access_token;
  }

  private async getGatewayUrl(accessToken: string): Promise<string> {
    const data = await jsonRequest<{ url?: string; message?: string }>(`${this.config.apiBase || DEFAULT_API_BASE}/gateway`, {
      method: "GET",
      headers: { authorization: `QQBot ${accessToken}` },
    });
    if (!data.url) throw new Error(`qq gateway fetch failed: ${data.message || "missing url"}`);
    return data.url;
  }

  private async sendText(accessToken: string, target: QQTarget, content: string, replyTo?: string): Promise<void> {
    const base = this.config.apiBase || DEFAULT_API_BASE;
    if (target.scene === "private") {
      await jsonRequest(`${base}/v2/users/${target.id}/messages`, {
        method: "POST",
        headers: { authorization: `QQBot ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(buildTextBody(content, replyTo)),
      });
      return;
    }
    if (target.scene === "group") {
      await jsonRequest(`${base}/v2/groups/${target.id}/messages`, {
        method: "POST",
        headers: { authorization: `QQBot ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(buildTextBody(content, replyTo)),
      });
      return;
    }
    await jsonRequest(`${base}/channels/${target.id}/messages`, {
      method: "POST",
      headers: { authorization: `QQBot ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(replyTo ? { content, msg_id: replyTo } : { content }),
    });
  }

  private async sendWithMedia(accessToken: string, target: QQTarget, msg: OutboundMessage): Promise<void> {
    if (target.scene === "channel") {
      throw new Error("qq channel media send is not implemented yet");
    }
    for (let index = 0; index < msg.media.length; index += 1) {
      const media = msg.media[index]!;
      const upload = await this.uploadMedia(accessToken, target, media);
      const content = index === 0 ? msg.content.trim() : "";
      await this.sendMediaMessage(accessToken, target, upload.fileInfo, index === 0 ? msg.replyTo : undefined, content || undefined);
    }
    if (msg.media.length === 0 && msg.content.trim()) {
      await this.sendText(accessToken, target, msg.content, msg.replyTo);
    }
  }

  private async uploadMedia(accessToken: string, target: QQTarget, mediaRef: string): Promise<{ fileInfo: string; fileType: MediaFileType }> {
    const fileType = inferMediaFileType(mediaRef);
    const base = this.config.apiBase || DEFAULT_API_BASE;
    const endpoint = target.scene === "private" ? `${base}/v2/users/${target.id}/files` : `${base}/v2/groups/${target.id}/files`;
    const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: false };

    if (isRemoteUrl(mediaRef)) {
      body.url = mediaRef;
    } else if (isDataUrl(mediaRef)) {
      const parsed = parseDataUrl(mediaRef);
      body.file_data = parsed.base64;
      if (fileType === MediaFileType.FILE) body.file_name = `upload.${parsed.mime.split("/").pop() || "bin"}`;
    } else {
      const local = readLocalFileAsBase64(mediaRef);
      body.file_data = local.base64;
      if (fileType === MediaFileType.FILE) body.file_name = local.fileName;
    }

    const result = await jsonRequest<UploadMediaResponse>(endpoint, {
      method: "POST",
      headers: { authorization: `QQBot ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.file_info) throw new Error("qq media upload failed: missing file_info");
    return { fileInfo: result.file_info, fileType };
  }

  private async sendMediaMessage(accessToken: string, target: QQTarget, fileInfo: string, replyTo?: string, content?: string): Promise<void> {
    const base = this.config.apiBase || DEFAULT_API_BASE;
    const body = buildMediaBody(fileInfo, replyTo, content);
    const url = target.scene === "private"
      ? `${base}/v2/users/${target.id}/messages`
      : `${base}/v2/groups/${target.id}/messages`;
    await jsonRequest(url, {
      method: "POST",
      headers: { authorization: `QQBot ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private startCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [key, ts] of this.processed) if (ts < cutoff) this.processed.delete(key);
      const outboundCutoff = Date.now() - OUTBOUND_DEDUP_WINDOW_MS;
      for (const [key, value] of this.lastSentContent) if (value.time < outboundCutoff) this.lastSentContent.delete(key);
    }, 60_000);
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const prev = this.processed.get(key);
    if (prev && now - prev <= DEDUP_TTL_MS) return true;
    this.processed.set(key, now);
    this.scheduleDedupFlush();
    return false;
  }

  private scheduleDedupFlush(): void {
    if (!this.config.dedupPersist || this.dedupFlushTimer) return;
    this.dedupFlushTimer = setTimeout(() => {
      this.dedupFlushTimer = null;
      void this.flushDedupToDisk(false);
    }, DEDUP_FLUSH_DELAY_MS);
  }

  private async loadPersistentDedup(): Promise<void> {
    if (!this.config.dedupPersist || !this.config.dedupFile || !existsSync(this.config.dedupFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.config.dedupFile, "utf-8")) as PersistedDedup;
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [key, value] of Object.entries(raw || {})) if (typeof value === "number" && value >= cutoff) this.processed.set(key, value);
    } catch (err) {
      logger.warn("qq", `failed to load dedup file: ${String(err)}`);
    }
  }

  private async flushDedupToDisk(force: boolean): Promise<void> {
    if (!this.config.dedupPersist || !this.config.dedupFile) return;
    if (!force && !this.processed.size) return;
    try {
      mkdirSync(dirname(this.config.dedupFile), { recursive: true });
      const cutoff = Date.now() - DEDUP_TTL_MS;
      const payload: PersistedDedup = {};
      for (const [key, value] of this.processed) if (value >= cutoff) payload[key] = value;
      writeFileSync(this.config.dedupFile, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      logger.warn("qq", `failed to persist dedup file: ${String(err)}`);
    }
  }
}
