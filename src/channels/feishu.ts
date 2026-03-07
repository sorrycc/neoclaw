import type { Channel } from "./channel.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { URL } from "url";
import { dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "../config/schema.js";
import type { InboundMessage, OutboundMessage } from "../bus/types.js";
import type { MessageBus } from "../bus/message-bus.js";
import { logger } from "../logger.js";

type ReceiveIdType = "chat_id" | "open_id" | "user_id";
type FeishuChatType = "p2p" | "private" | "group";
type FeishuMessageType = "text" | "post" | "image" | "audio" | "file" | "video" | "media" | string;

interface TokenCache {
  token: string;
  expiry: number;
}

interface FeishuMention {
  key?: string;
  name?: string;
  id?: {
    open_id?: string;
    user_id?: string;
  };
}

interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
    };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: FeishuChatType;
    message_type?: FeishuMessageType;
    content?: string;
    mentions?: FeishuMention[];
    create_time?: string;
  };
}

const DEDUP_TTL = 5 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 20_000;
const DEDUP_FLUSH_DELAY_MS = 2_000;
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN = 120;
const WEBHOOK_RATE_WINDOW_MS = 60_000;
const DEFAULT_WS_RECONNECT_BASE_MS = 1_000;
const DEFAULT_WS_RECONNECT_MAX_MS = 30_000;
const WS_STOP_WAIT_MS = 3_000;

type PersistedDedup = Record<string, number>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function resolveApiBase(domain?: string): string {
  const raw = (domain || "feishu").trim();
  const normalized = raw.toLowerCase();
  if (!normalized || normalized === "feishu") return "https://open.feishu.cn";
  if (normalized === "lark") return "https://open.larksuite.com";
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw.replace(/\/+$/, "");
  return `https://${raw.replace(/\/+$/, "")}`;
}

function resolveReceiveTarget(chatId: string): { receiveIdType: ReceiveIdType; receiveId: string } {
  const rawWithProvider = chatId.trim();
  if (!rawWithProvider) throw new Error("feishu send failed: empty target");
  const raw = rawWithProvider.replace(/^(feishu|lark):/i, "").trim();
  if (!raw) throw new Error("feishu send failed: empty target after provider prefix");
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const prefix = raw.slice(0, idx).toLowerCase();
    const receiveId = raw.slice(idx + 1).trim();
    if (prefix === "chat" || prefix === "chat_id" || prefix === "group" || prefix === "channel") {
      return { receiveIdType: "chat_id", receiveId };
    }
    if (prefix === "open" || prefix === "open_id") return { receiveIdType: "open_id", receiveId };
    if (prefix === "user" || prefix === "user_id" || prefix === "dm") {
      if (receiveId.startsWith("ou_")) return { receiveIdType: "open_id", receiveId };
      return { receiveIdType: "user_id", receiveId };
    }
  }

  if (raw.startsWith("oc_")) return { receiveIdType: "chat_id", receiveId: raw };
  if (raw.startsWith("ou_")) return { receiveIdType: "open_id", receiveId: raw };
  return { receiveIdType: "chat_id", receiveId: raw };
}

function chunkText(input: string, limit: number): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > start + Math.floor(limit * 0.5)) end = nl;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

function validateFeishuConfig(config: FeishuConfig): string[] {
  const errors: string[] = [];
  if (!config.appId.trim()) errors.push("appId is required");
  if (!config.appSecret.trim()) errors.push("appSecret is required");

  const mode = config.connectionMode || "websocket";
  if (mode !== "websocket" && mode !== "webhook") {
    errors.push(`connectionMode must be "websocket" or "webhook" (received "${String(config.connectionMode)}")`);
  }

  if (mode === "webhook") {
    if (!config.verificationToken?.trim()) {
      errors.push("verificationToken is required when connectionMode=webhook");
    }
    const port = asPositiveInt(config.webhookPort, 3000);
    if (port > 65535) errors.push("webhookPort must be in range 1..65535");
    const path = (config.webhookPath || "/feishu/events").trim();
    if (!path) errors.push("webhookPath cannot be empty");
  }

  const wsBase = asPositiveInt(config.wsReconnectBaseMs, DEFAULT_WS_RECONNECT_BASE_MS);
  const wsMax = asPositiveInt(config.wsReconnectMaxMs, DEFAULT_WS_RECONNECT_MAX_MS);
  if (wsBase > wsMax) errors.push("wsReconnectBaseMs cannot be greater than wsReconnectMaxMs");

  const maxBody = asPositiveInt(config.webhookMaxBodyBytes, DEFAULT_WEBHOOK_MAX_BODY_BYTES);
  if (maxBody < 1024) errors.push("webhookMaxBodyBytes should be >= 1024");

  if (config.dedupPersist && !(config.dedupFile || "").trim()) {
    errors.push("dedupFile is required when dedupPersist=true");
  }

  return errors;
}

export class FeishuChannel implements Channel {
  readonly name = "feishu" as const;
  private tokenCache: TokenCache | null = null;
  private running = false;
  private server: Server | null = null;
  private webhookHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  private wsClient: Lark.WSClient | null = null;
  private wsLoopPromise: Promise<void> | null = null;
  private wsLoopToken = 0;
  private wsStopRequested = false;
  private processed = new Map<string, number>();
  private dedupDirty = false;
  private dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private webhookHits = new Map<string, number[]>();
  private chatQueues = new Map<string, Promise<void>>();
  private lastSentContent = new Map<string, { content: string; time: number }>();
  private botOpenId = "";

  constructor(private config: FeishuConfig, private bus: MessageBus) {}

  async start(): Promise<void> {
    const errors = validateFeishuConfig(this.config);
    if (errors.length > 0) {
      throw new Error(`invalid feishu config: ${errors.join("; ")}`);
    }
    this.running = true;
    await this.loadPersistentDedup();
    this.startCleanup();

    await this.startTransport();
    void this.prefetchBotOpenId();
    logger.info(
      "feishu",
      `channel started (mode=${this.config.connectionMode || "websocket"}, dedup=${this.config.dedupPersist ? "memory+disk" : "memory"})`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wsStopRequested = true;
    this.tokenCache = null;
    this.botOpenId = "";
    this.chatQueues.clear();
    this.lastSentContent.clear();
    if (this.dedupFlushTimer) {
      clearTimeout(this.dedupFlushTimer);
      this.dedupFlushTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.flushDedupToDisk(true);
    await this.stopTransport();
    this.webhookHits.clear();
    this.processed.clear();
    logger.info("feishu", "stopped");
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("feishu appId/appSecret is required");
    }
    if (msg.metadata.progress) return;

    let content = msg.content;
    if (msg.media.length > 0) {
      logger.warn("feishu", "media send is not implemented yet; ignoring media payload");
      const mediaLines = msg.media.map((_, idx) => `[Attachment ${idx + 1}]`);
      content = [content, ...mediaLines].filter(Boolean).join("\n").trim();
    }

    // Outbound dedup: skip if same content was sent to same chatId within 5s
    const dedup = content + msg.media.join(",");
    const last = this.lastSentContent.get(msg.chatId);
    if (last && last.content === dedup && Date.now() - last.time <= 5000) return;
    this.lastSentContent.set(msg.chatId, { content: dedup, time: Date.now() });

    const chunks = chunkText(content, 1800);
    for (const chunk of chunks) {
      await this.sendText(msg.chatId, chunk);
    }
  }

  updateConfig(config: FeishuConfig): void {
    const errors = validateFeishuConfig(config);
    if (errors.length > 0) {
      logger.error("feishu", `ignoring invalid config update: ${errors.join("; ")}`);
      return;
    }
    const prev = this.config;
    this.config = config;
    this.tokenCache = null;
    if (this.running && config.dedupPersist && (!prev.dedupPersist || prev.dedupFile !== config.dedupFile)) {
      void this.loadPersistentDedup();
    }
    if (this.running && prev.dedupPersist && !config.dedupPersist) {
      void this.flushDedupToDisk(true);
    }
    if (this.running) {
      void this.applyTransportConfigChange(prev, config).catch((err) => {
        logger.error("feishu", "failed to apply transport config update:", err);
      });
    }
    logger.info("feishu", `config updated, allowFrom=${config.allowFrom.join(",")}`);
  }

  private async applyTransportConfigChange(prev: FeishuConfig, next: FeishuConfig): Promise<void> {
    const prevMode = prev.connectionMode || "websocket";
    const nextMode = next.connectionMode || "websocket";
    const changed =
      prev.appId !== next.appId ||
      prev.appSecret !== next.appSecret ||
      prev.domain !== next.domain ||
      prev.webhookHost !== next.webhookHost ||
      prev.webhookPort !== next.webhookPort ||
      prev.webhookPath !== next.webhookPath ||
      prev.verificationToken !== next.verificationToken ||
      prev.encryptKey !== next.encryptKey ||
      prevMode !== nextMode;
    if (!changed) return;

    await this.stopTransport();
    if (this.running) {
      await this.startTransport();
    }
  }

  private resolveSdkDomain(): Lark.Domain | string {
    const normalized = (this.config.domain || "feishu").trim().toLowerCase();
    if (!normalized || normalized === "feishu") return Lark.Domain.Feishu;
    if (normalized === "lark") return Lark.Domain.Lark;
    return this.config.domain || Lark.Domain.Feishu;
  }

  private createEventDispatcher(): Lark.EventDispatcher {
    return new Lark.EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
      loggerLevel: Lark.LoggerLevel.info,
    }).register({
      "im.message.receive_v1": async (data: unknown) => {
        this.handleInboundEventData(data);
      },
    });
  }

  private async startTransport(): Promise<void> {
    const mode = this.config.connectionMode || "websocket";
    if (mode === "webhook") {
      await this.startWebhookServer();
      return;
    }
    await this.startWebsocketClient();
  }

  private async stopTransport(): Promise<void> {
    await this.stopWebhookServer();
    await this.stopWebsocketClient();
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const { receiveIdType, receiveId } = resolveReceiveTarget(chatId);
    const token = await this.getAccessToken();
    const base = resolveApiBase(this.config.domain);
    const textHash = createHash("sha1").update(text).digest("hex").slice(0, 10);
    logger.debug("feishu", `sendText: pid=${process.pid} target=${receiveIdType}:${receiveId} hash=${textHash} len=${text.length}`);

    const res = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || Number(data.code ?? -1) !== 0) {
      const code = data.code !== undefined ? String(data.code) : String(res.status);
      const message = data.msg !== undefined ? String(data.msg) : "unknown error";
      throw new Error(`feishu send failed: ${message} (code=${code})`);
    }
    const sentMessageId = String((data as any)?.data?.message_id || "");
    logger.info(
      "feishu",
      `sendText ok: pid=${process.pid} target=${receiveIdType}:${receiveId} hash=${textHash}${sentMessageId ? ` message_id=${sentMessageId}` : ""}`,
    );
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiry > now + 60_000) {
      return this.tokenCache.token;
    }

    const base = resolveApiBase(this.config.domain);
    const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || Number(data.code ?? -1) !== 0) {
      const code = data.code !== undefined ? String(data.code) : String(res.status);
      const message = data.msg !== undefined ? String(data.msg) : "unknown error";
      throw new Error(`feishu token fetch failed: ${message} (code=${code})`);
    }

    const token = String(data.tenant_access_token || "");
    if (!token) throw new Error("feishu token fetch failed: empty tenant_access_token");

    const expireSeconds = Number(data.expire || 7200);
    this.tokenCache = {
      token,
      expiry: now + Math.max(600, expireSeconds) * 1000,
    };
    return token;
  }

  private async prefetchBotOpenId(): Promise<void> {
    try {
      const token = await this.getAccessToken();
      const base = resolveApiBase(this.config.domain);
      const res = await fetch(`${base}/open-apis/bot/v3/info`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      const openId = String((data as any)?.bot?.open_id || "");
      if (openId) this.botOpenId = openId;
    } catch (err) {
      logger.warn("feishu", "bot info prefetch failed:", err);
    }
  }

  private isAllowed(senderId: string): boolean {
    if (this.config.allowFrom.length === 0) return true;
    return this.config.allowFrom.some((a) => senderId.includes(a));
  }

  private async startWebhookServer(): Promise<void> {
    if (this.server) return;
    const host = this.config.webhookHost || "127.0.0.1";
    const port = this.config.webhookPort || 3000;
    const dispatcher = this.createEventDispatcher();
    this.webhookHandler = Lark.adaptDefault(this.webhookPath(), dispatcher, { autoChallenge: true });

    const server = createServer((req, res) => {
      void this.handleWebhook(req, res);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (err) {
      server.close();
      throw err;
    }
    this.server = server;
    logger.info("feishu", `webhook listening on http://${host}:${port}${this.webhookPath()}`);
  }

  private async stopWebhookServer(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.webhookHandler = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async startWebsocketClient(): Promise<void> {
    if (this.wsLoopPromise) return;
    this.wsStopRequested = false;
    const token = ++this.wsLoopToken;
    this.wsLoopPromise = this.runWebsocketLoop(token).finally(() => {
      if (this.wsLoopToken === token) {
        this.wsLoopPromise = null;
        this.wsClient = null;
      }
    });
    logger.info("feishu", "websocket loop started");
  }

  private async stopWebsocketClient(): Promise<void> {
    if (!this.wsClient && !this.wsLoopPromise) return;
    this.wsStopRequested = true;
    this.wsLoopToken += 1;
    const pending = this.wsLoopPromise;
    const client = this.wsClient;
    this.wsClient = null;
    try {
      client?.close({ force: true });
    } catch (err) {
      logger.warn("feishu", "websocket close failed:", err);
    }
    if (pending) {
      await Promise.race([
        pending,
        sleep(WS_STOP_WAIT_MS),
      ]);
    }
    this.wsClient = null;
    this.wsLoopPromise = null;
  }

  private async runWebsocketLoop(token: number): Promise<void> {
    const dispatcher = this.createEventDispatcher();
    const wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.resolveSdkDomain(),
      loggerLevel: Lark.LoggerLevel.info,
      // SDK start() is non-blocking; keep one client alive and let SDK handle reconnect.
      autoReconnect: true,
    });
    this.wsClient = wsClient;
    try {
      logger.info("feishu", "websocket connecting (attempt=1)");
      await wsClient.start({ eventDispatcher: dispatcher });
      while (this.running && !this.wsStopRequested && token === this.wsLoopToken) {
        await sleep(1000);
      }
    } catch (err) {
      if (this.running && !this.wsStopRequested && token === this.wsLoopToken) {
        logger.error("feishu", "websocket client failed:", err);
      }
    } finally {
      try {
        if (this.wsClient === wsClient) wsClient.close({ force: true });
      } catch {}
      if (this.wsClient === wsClient) this.wsClient = null;
    }
  }

  private nextReconnectDelay(attempt: number): number {
    const base = asPositiveInt(this.config.wsReconnectBaseMs, DEFAULT_WS_RECONNECT_BASE_MS);
    const max = asPositiveInt(this.config.wsReconnectMaxMs, DEFAULT_WS_RECONNECT_MAX_MS);
    const floor = Math.min(base, max);
    const exp = Math.min(max, floor * Math.pow(2, Math.max(0, attempt)));
    const jitter = Math.floor(Math.random() * Math.max(200, Math.floor(exp * 0.2)));
    return Math.min(max, exp + jitter);
  }

  private webhookPath(): string {
    const path = (this.config.webhookPath || "/feishu/events").trim();
    if (!path) return "/feishu/events";
    return path.startsWith("/") ? path : `/${path}`;
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let onData: ((chunk: Buffer | string) => void) | null = null;
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== this.webhookPath()) {
        this.sendJson(res, 404, { error: "not found" });
        return;
      }
      if (!this.webhookHandler) {
        this.sendJson(res, 503, { error: "webhook handler not ready" });
        return;
      }
      if (req.method !== "POST" && req.method !== "GET") {
        this.sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (this.isWebhookRateLimited(req)) {
        this.sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }
      if (req.method === "POST") {
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (contentType && !contentType.includes("application/json")) {
          this.sendJson(res, 415, { error: "content-type must be application/json" });
          return;
        }
      }
      const maxBody = asPositiveInt(this.config.webhookMaxBodyBytes, DEFAULT_WEBHOOK_MAX_BODY_BYTES);
      const contentLength = Number(req.headers["content-length"] || 0);
      if (Number.isFinite(contentLength) && contentLength > maxBody) {
        this.sendJson(res, 413, { error: "payload too large" });
        return;
      }
      const timeoutMs = asPositiveInt(this.config.webhookBodyTimeoutMs, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS);
      req.setTimeout(timeoutMs, () => {
        logger.warn("feishu", "webhook body read timeout");
        this.sendJson(res, 408, { error: "request timeout" });
        req.destroy();
      });
      let bodyBytes = 0;
      onData = (chunk: Buffer | string) => {
        bodyBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (bodyBytes > maxBody) {
          logger.warn("feishu", `webhook body too large (${bodyBytes} > ${maxBody})`);
          this.sendJson(res, 413, { error: "payload too large" });
          req.destroy();
        }
      };
      req.on("data", onData);
      await this.webhookHandler(req, res);
    } catch (err) {
      logger.error("feishu", "webhook handler error:", err);
      this.sendJson(res, 500, { error: "internal error" });
    } finally {
      if (onData) req.off("data", onData);
      req.setTimeout(0);
    }
  }

  private handleInboundEventData(data: unknown): void {
    const raw = data as any;
    const eventId = String(raw?.header?.event_id || raw?.event_id || "");
    const maybeEvent = raw?.event && raw?.event?.message ? raw.event : raw;
    if (!maybeEvent?.message?.chat_id) return;
    const chatId = String(maybeEvent.message.chat_id || "");
    this.enqueueInbound(chatId || "unknown", () => {
      this.handleInboundEvent(eventId, maybeEvent as FeishuMessageEvent);
    });
  }

  private handleInboundEvent(eventId: string, event: FeishuMessageEvent): void {
    const message = event.message;
    if (!message?.chat_id || !message?.message_id) return;

    const senderOpenId = event.sender?.sender_id?.open_id || "";
    const senderUserId = event.sender?.sender_id?.user_id || "";
    const senderId = senderOpenId || senderUserId;
    if (!senderId) return;
    if (!this.isAllowed(senderId)) return;

    logger.debug(
      "feishu",
      `inbound: pid=${process.pid} event_id=${eventId || "-"} message_id=${message.message_id} chat_id=${message.chat_id} sender=${senderId}`,
    );

    // message_id is stable across retries/re-deliveries and safer than event_id for dedup.
    if (this.isDuplicate(`msg:${message.message_id}`)) {
      logger.debug("feishu", `inbound dedup hit: pid=${process.pid} message_id=${message.message_id}`);
      return;
    }

    const chatType: FeishuChatType = message.chat_type || "group";
    const isGroup = chatType === "group";
    const mentioned = this.isMentioned(message);
    const requireMention = isGroup ? this.config.requireMention !== false : false;
    if (requireMention && !mentioned) return;

    let content = this.parseMessageContent(message.content || "", message.message_type || "text");
    if (mentioned) {
      content = this.stripMentionKeys(content, message.mentions);
    }
    if (!content) {
      content = `[${message.message_type || "message"}]`;
    }

    const inbound: InboundMessage = {
      channel: "feishu",
      senderId,
      chatId: `chat_id:${message.chat_id}`,
      content,
      timestamp: new Date(),
      media: [],
      metadata: {
        eventId,
        messageId: message.message_id,
        chatType,
        messageType: message.message_type || "text",
        mentioned,
        isGroup,
      },
    };
    this.bus.publishInbound(inbound);
  }

  private enqueueInbound(chatId: string, task: () => void): void {
    const prev = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = prev.then(
      async () => task(),
      async () => task(),
    );
    this.chatQueues.set(chatId, next);
    void next.finally(() => {
      if (this.chatQueues.get(chatId) === next) this.chatQueues.delete(chatId);
    });
  }

  private isMentioned(message: NonNullable<FeishuMessageEvent["message"]>): boolean {
    const rawContent = message.content || "";
    if (rawContent.includes("@_all")) return true;
    const mentions = message.mentions || [];
    if (mentions.length === 0) {
      return /<at\b/i.test(rawContent);
    }
    if (!this.botOpenId) return mentions.length > 0 || /<at\b/i.test(rawContent);
    if (mentions.some((m) => m.id?.open_id === this.botOpenId)) return true;
    return this.contentMentionsBot(rawContent, this.botOpenId);
  }

  private contentMentionsBot(rawContent: string, botOpenId: string): boolean {
    if (!rawContent) return false;
    if (rawContent.includes(botOpenId)) return true;
    try {
      const parsed = JSON.parse(rawContent) as unknown;
      return this.scanAtTag(parsed, botOpenId);
    } catch {
      return false;
    }
  }

  private scanAtTag(input: unknown, botOpenId: string): boolean {
    if (!input || typeof input !== "object") return false;
    if (Array.isArray(input)) {
      return input.some((v) => this.scanAtTag(v, botOpenId));
    }
    const obj = input as Record<string, unknown>;
    const tag = String(obj.tag || "").toLowerCase();
    if (tag === "at") {
      const openId = String(obj.open_id || obj.user_id || "");
      if (openId && openId === botOpenId) return true;
    }
    return Object.values(obj).some((v) => this.scanAtTag(v, botOpenId));
  }

  private stripMentionKeys(text: string, mentions?: FeishuMention[]): string {
    let result = text;
    if (mentions && mentions.length > 0) {
      for (const mention of mentions) {
        const key = mention.key || "";
        if (!key) continue;
        result = result.split(key).join("").trim();
      }
    }
    result = result
      .replace(/<at\b[^>]*>[^<]*<\/at>/gi, " ")
      .replace(/@_all/g, " ");
    return result.replace(/\s+/g, " ").trim();
  }

  private parseMessageContent(raw: string, messageType: FeishuMessageType): string {
    if (messageType === "text") {
      try {
        const parsed = JSON.parse(raw) as { text?: string };
        return (parsed.text || "").trim();
      } catch {
        return raw.trim();
      }
    }

    if (messageType === "post") {
      return this.parsePostPlainText(raw);
    }

    if (messageType === "image") return "[Image]";
    if (messageType === "audio") return "[Audio]";
    if (messageType === "video" || messageType === "media") return "[Video]";
    if (messageType === "file") return "[File]";
    if (messageType === "interactive") return "[Card]";
    return raw.trim();
  }

  private parsePostPlainText(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as Record<string, { content?: unknown }>;
      const locale = Object.values(parsed).find((v) => v && Array.isArray(v.content));
      const content = locale?.content;
      if (!Array.isArray(content)) return "";

      const lines: string[] = [];
      for (const row of content) {
        if (!Array.isArray(row)) continue;
        const lineParts: string[] = [];
        for (const part of row) {
          if (!part || typeof part !== "object") continue;
          const obj = part as { tag?: string; text?: string; image_key?: string };
          const tag = (obj.tag || "").toLowerCase();
          if (tag === "text" || tag === "a" || tag === "at") {
            if (obj.text) lineParts.push(obj.text);
          } else if (tag === "code") {
            if (obj.text) lineParts.push(`\`${obj.text}\``);
          } else if (tag === "code_block" || tag === "pre") {
            if (obj.text) lineParts.push(`\n${obj.text}\n`);
          } else if (tag === "img" || tag === "media") {
            lineParts.push(obj.image_key ? "[Image]" : "[Media]");
          }
        }
        const line = lineParts.join("").trim();
        if (line) lines.push(line);
      }
      return lines.join("\n").trim();
    } catch {
      return "";
    }
  }

  private isWebhookRateLimited(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const cutoff = now - WEBHOOK_RATE_WINDOW_MS;
    const prev = this.webhookHits.get(remote) || [];
    const next = prev.filter((t) => t >= cutoff);
    next.push(now);
    this.webhookHits.set(remote, next);
    const limit = asPositiveInt(this.config.webhookRateLimitPerMin, DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN);
    return next.length > limit;
  }

  private dedupFilePath(): string {
    return (this.config.dedupFile || "").trim();
  }

  private startCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const dedupCutoff = now - DEDUP_TTL;
      for (const [k, t] of this.processed) {
        if (t < dedupCutoff) this.processed.delete(k);
      }
      this.trimDedupSize();

      const rateCutoff = now - WEBHOOK_RATE_WINDOW_MS;
      for (const [k, hits] of this.webhookHits) {
        const next = hits.filter((t) => t >= rateCutoff);
        if (next.length === 0) this.webhookHits.delete(k);
        else this.webhookHits.set(k, next);
      }
    }, 60_000);
  }

  private isDuplicate(key: string): boolean {
    if (this.processed.has(key)) return true;
    this.processed.set(key, Date.now());
    this.trimDedupSize();
    if (this.config.dedupPersist) {
      this.dedupDirty = true;
      this.scheduleDedupFlush();
    }
    return false;
  }

  private trimDedupSize(): void {
    if (this.processed.size <= DEDUP_MAX_ENTRIES) return;
    const entries = [...this.processed.entries()].sort((a, b) => a[1] - b[1]);
    const remove = entries.length - DEDUP_MAX_ENTRIES;
    for (let i = 0; i < remove; i++) {
      this.processed.delete(entries[i][0]);
    }
  }

  private scheduleDedupFlush(): void {
    if (!this.config.dedupPersist || this.dedupFlushTimer) return;
    this.dedupFlushTimer = setTimeout(() => {
      this.dedupFlushTimer = null;
      void this.flushDedupToDisk(false);
    }, DEDUP_FLUSH_DELAY_MS);
  }

  private async loadPersistentDedup(): Promise<void> {
    if (!this.config.dedupPersist) return;
    const file = this.dedupFilePath();
    if (!file) return;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as PersistedDedup;
      const cutoff = Date.now() - DEDUP_TTL;
      let loaded = 0;
      for (const [k, t] of Object.entries(raw)) {
        const ts = Number(t);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        this.processed.set(k, ts);
        loaded += 1;
      }
      this.trimDedupSize();
      if (loaded > 0) logger.info("feishu", `loaded ${loaded} dedup keys from disk`);
    } catch (err) {
      logger.warn("feishu", "failed to load persistent dedup file:", err);
    }
  }

  private async flushDedupToDisk(force: boolean): Promise<void> {
    if (!this.config.dedupPersist) return;
    if (!force && !this.dedupDirty) return;
    const file = this.dedupFilePath();
    if (!file) return;
    const cutoff = Date.now() - DEDUP_TTL;
    const payload: PersistedDedup = {};
    for (const [k, t] of this.processed) {
      if (t >= cutoff) payload[k] = t;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(payload), "utf-8");
      this.dedupDirty = false;
    } catch (err) {
      logger.warn("feishu", `failed to flush dedup file (${file}):`, err);
    }
  }

  private sendJson(res: ServerResponse, code: number, body: Record<string, unknown>): void {
    if (res.headersSent) return;
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}
