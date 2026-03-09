import { join } from "path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, watch, type FSWatcher } from "fs";
import type { ProviderConfig } from "@neovate/code";
import { logger } from "../logger.js";

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  allowFrom: string[];
  proxy?: string;
}

export interface CliConfig {
  enabled: boolean;
}

export interface DingtalkConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  corpId?: string;
  allowFrom: string[];
  keepAlive?: boolean;
}

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  allowFrom: string[];
  domain?: string;
  connectionMode?: "websocket" | "webhook";
  encryptKey?: string;
  verificationToken?: string;
  webhookHost?: string;
  webhookPort?: number;
  webhookPath?: string;
  requireMention?: boolean;
  webhookMaxBodyBytes?: number;
  webhookBodyTimeoutMs?: number;
  webhookRateLimitPerMin?: number;
  wsReconnectBaseMs?: number;
  wsReconnectMaxMs?: number;
  dedupPersist?: boolean;
  dedupFile?: string;
}

export interface QQConfig {
  enabled: boolean;
  appId: string;
  clientSecret: string;
  allowFrom: string[];
  requireMention?: boolean;
  apiBase?: string;
  wsIntentMask?: number;
  wsReconnectBaseMs?: number;
  wsReconnectMaxMs?: number;
  dedupPersist?: boolean;
  dedupFile?: string;
}

export interface ChannelsConfig {
  telegram: TelegramConfig;
  cli: CliConfig;
  dingtalk: DingtalkConfig;
  feishu: FeishuConfig;
  qq: QQConfig;
}

export interface AgentConfig {
  model: string;
  codeModel?: string;
  memoryWindow: number;
  workspace: string;
  maxMemorySize?: number;
  consolidationTimeout?: number;
  subagentTimeout?: number;
  memorySearch?: MemorySearchConfig;
  memoryFlush?: MemoryFlushConfig;
}

export interface MemorySearchConfig {
  enabled?: boolean;
  provider?: "fts" | "hybrid";
  maxResults?: number;
  minScore?: number;
  indexPath?: string;
  autoRecall?: boolean;
  recencyHalfLifeDays?: number;
  embeddings?: {
    enabled?: boolean;
    model?: string;
    dims?: number;
  };
}

export interface MemoryFlushConfig {
  enabled?: boolean;
  timeoutMs?: number;
}

export interface Config {
  agent: AgentConfig;
  channels: ChannelsConfig;
  providers?: Record<string, ProviderConfig>;
  logLevel?: string;
}

export function defaultConfig(baseDir: string): Config {
  return {
    agent: {
      model: "",
      memoryWindow: 50,
      workspace: join(baseDir, "workspace"),
      maxMemorySize: 40960,
      consolidationTimeout: 60000,
      memorySearch: {
        enabled: true,
        provider: "fts",
        maxResults: 5,
        minScore: 0,
        autoRecall: true,
        recencyHalfLifeDays: 30,
        embeddings: {
          enabled: false,
        },
      },
      memoryFlush: {
        enabled: true,
        timeoutMs: 20000,
      },
    },
    channels: {
      telegram: { enabled: false, token: "", allowFrom: [] },
      cli: { enabled: true },
      dingtalk: { enabled: false, clientId: "", clientSecret: "", robotCode: "", allowFrom: [] },
      feishu: {
        enabled: false,
        appId: "",
        appSecret: "",
        allowFrom: [],
        domain: "feishu",
        connectionMode: "websocket",
        webhookHost: "127.0.0.1",
        webhookPort: 3000,
        webhookPath: "/feishu/events",
        requireMention: true,
        webhookMaxBodyBytes: 1024 * 1024,
        webhookBodyTimeoutMs: 10_000,
        webhookRateLimitPerMin: 120,
        wsReconnectBaseMs: 1000,
        wsReconnectMaxMs: 30_000,
        dedupPersist: false,
        dedupFile: join(baseDir, "feishu-dedup.json"),
      },
      qq: {
        enabled: false,
        appId: "",
        clientSecret: "",
        allowFrom: [],
        requireMention: true,
        apiBase: "https://api.sgroup.qq.com",
        wsIntentMask: (1 << 30) | (1 << 12) | (1 << 25),
        wsReconnectBaseMs: 1000,
        wsReconnectMaxMs: 30_000,
        dedupPersist: false,
        dedupFile: join(baseDir, "qq-dedup.json"),
      },
    },
    logLevel: "debug",
  };
}

function envOverride(config: Config): Config {
  const t = process.env.NEOCLAW_TELEGRAM_TOKEN;
  if (t) config.channels.telegram.token = t;

  const m = process.env.NEOCLAW_MODEL;
  if (m) config.agent.model = m;

  if (process.env.NEOCLAW_TELEGRAM_ENABLED === "true") {
    config.channels.telegram.enabled = true;
  }

  const af = process.env.NEOCLAW_TELEGRAM_ALLOW_FROM;
  if (af) config.channels.telegram.allowFrom = af.split(",").map((s) => s.trim());

  if (process.env.NEOCLAW_DINGTALK_ENABLED === "true") {
    config.channels.dingtalk.enabled = true;
  }
  const dci = process.env.NEOCLAW_DINGTALK_CLIENT_ID;
  if (dci) config.channels.dingtalk.clientId = dci;
  const dcs = process.env.NEOCLAW_DINGTALK_CLIENT_SECRET;
  if (dcs) config.channels.dingtalk.clientSecret = dcs;
  const drc = process.env.NEOCLAW_DINGTALK_ROBOT_CODE;
  if (drc) config.channels.dingtalk.robotCode = drc;
  const dcorp = process.env.NEOCLAW_DINGTALK_CORP_ID;
  if (dcorp) config.channels.dingtalk.corpId = dcorp;
  const daf = process.env.NEOCLAW_DINGTALK_ALLOW_FROM;
  if (daf) config.channels.dingtalk.allowFrom = daf.split(",").map((s) => s.trim());

  if (process.env.NEOCLAW_FEISHU_ENABLED === "true") {
    config.channels.feishu.enabled = true;
  }
  const fappId = process.env.NEOCLAW_FEISHU_APP_ID;
  if (fappId) config.channels.feishu.appId = fappId;
  const fappSecret = process.env.NEOCLAW_FEISHU_APP_SECRET;
  if (fappSecret) config.channels.feishu.appSecret = fappSecret;
  const faf = process.env.NEOCLAW_FEISHU_ALLOW_FROM;
  if (faf) config.channels.feishu.allowFrom = faf.split(",").map((s) => s.trim());
  const fdomain = process.env.NEOCLAW_FEISHU_DOMAIN;
  if (fdomain) config.channels.feishu.domain = fdomain;
  const fmode = process.env.NEOCLAW_FEISHU_CONNECTION_MODE;
  if (fmode === "websocket" || fmode === "webhook") config.channels.feishu.connectionMode = fmode;
  const fencrypt = process.env.NEOCLAW_FEISHU_ENCRYPT_KEY;
  if (fencrypt) config.channels.feishu.encryptKey = fencrypt;
  const fverify = process.env.NEOCLAW_FEISHU_VERIFICATION_TOKEN;
  if (fverify) config.channels.feishu.verificationToken = fverify;
  const fhost = process.env.NEOCLAW_FEISHU_WEBHOOK_HOST;
  if (fhost) config.channels.feishu.webhookHost = fhost;
  const fport = process.env.NEOCLAW_FEISHU_WEBHOOK_PORT;
  if (fport) {
    const n = Number(fport);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.webhookPort = Math.floor(n);
  }
  const fpath = process.env.NEOCLAW_FEISHU_WEBHOOK_PATH;
  if (fpath) config.channels.feishu.webhookPath = fpath;
  const frem = process.env.NEOCLAW_FEISHU_REQUIRE_MENTION;
  if (frem === "true") config.channels.feishu.requireMention = true;
  if (frem === "false") config.channels.feishu.requireMention = false;
  const fmaxBody = process.env.NEOCLAW_FEISHU_WEBHOOK_MAX_BODY_BYTES;
  if (fmaxBody) {
    const n = Number(fmaxBody);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.webhookMaxBodyBytes = Math.floor(n);
  }
  const fbodyTimeout = process.env.NEOCLAW_FEISHU_WEBHOOK_BODY_TIMEOUT_MS;
  if (fbodyTimeout) {
    const n = Number(fbodyTimeout);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.webhookBodyTimeoutMs = Math.floor(n);
  }
  const frate = process.env.NEOCLAW_FEISHU_WEBHOOK_RATE_LIMIT_PER_MIN;
  if (frate) {
    const n = Number(frate);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.webhookRateLimitPerMin = Math.floor(n);
  }
  const freconnBase = process.env.NEOCLAW_FEISHU_WS_RECONNECT_BASE_MS;
  if (freconnBase) {
    const n = Number(freconnBase);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.wsReconnectBaseMs = Math.floor(n);
  }
  const freconnMax = process.env.NEOCLAW_FEISHU_WS_RECONNECT_MAX_MS;
  if (freconnMax) {
    const n = Number(freconnMax);
    if (Number.isFinite(n) && n > 0) config.channels.feishu.wsReconnectMaxMs = Math.floor(n);
  }
  const fdedupPersist = process.env.NEOCLAW_FEISHU_DEDUP_PERSIST;
  if (fdedupPersist === "true") config.channels.feishu.dedupPersist = true;
  if (fdedupPersist === "false") config.channels.feishu.dedupPersist = false;
  const fdedupFile = process.env.NEOCLAW_FEISHU_DEDUP_FILE;
  if (fdedupFile) config.channels.feishu.dedupFile = fdedupFile;

  if (process.env.NEOCLAW_QQ_ENABLED === "true") {
    config.channels.qq.enabled = true;
  }
  const qappId = process.env.NEOCLAW_QQ_APP_ID;
  if (qappId) config.channels.qq.appId = qappId;
  const qsecret = process.env.NEOCLAW_QQ_CLIENT_SECRET;
  if (qsecret) config.channels.qq.clientSecret = qsecret;
  const qaf = process.env.NEOCLAW_QQ_ALLOW_FROM;
  if (qaf) config.channels.qq.allowFrom = qaf.split(",").map((s) => s.trim());
  const qmention = process.env.NEOCLAW_QQ_REQUIRE_MENTION;
  if (qmention === "true") config.channels.qq.requireMention = true;
  if (qmention === "false") config.channels.qq.requireMention = false;
  const qapiBase = process.env.NEOCLAW_QQ_API_BASE;
  if (qapiBase) config.channels.qq.apiBase = qapiBase;
  const qintent = process.env.NEOCLAW_QQ_WS_INTENT_MASK;
  if (qintent) {
    const n = Number(qintent);
    if (Number.isFinite(n) && n > 0) config.channels.qq.wsIntentMask = Math.floor(n);
  }
  const qreconnBase = process.env.NEOCLAW_QQ_WS_RECONNECT_BASE_MS;
  if (qreconnBase) {
    const n = Number(qreconnBase);
    if (Number.isFinite(n) && n > 0) config.channels.qq.wsReconnectBaseMs = Math.floor(n);
  }
  const qreconnMax = process.env.NEOCLAW_QQ_WS_RECONNECT_MAX_MS;
  if (qreconnMax) {
    const n = Number(qreconnMax);
    if (Number.isFinite(n) && n > 0) config.channels.qq.wsReconnectMaxMs = Math.floor(n);
  }
  const qdedupPersist = process.env.NEOCLAW_QQ_DEDUP_PERSIST;
  if (qdedupPersist === "true") config.channels.qq.dedupPersist = true;
  if (qdedupPersist === "false") config.channels.qq.dedupPersist = false;
  const qdedupFile = process.env.NEOCLAW_QQ_DEDUP_FILE;
  if (qdedupFile) config.channels.qq.dedupFile = qdedupFile;

  return config;
}

export function configPath(baseDir: string): string {
  return join(baseDir, "config.json");
}

export function loadConfig(baseDir: string): Config {
  const defaults = defaultConfig(baseDir);
  const path = configPath(baseDir);
  let config: Config;

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    config = { ...defaults, ...raw };
    config.agent = {
      ...defaults.agent,
      ...raw.agent,
      memorySearch: {
        ...defaults.agent.memorySearch,
        ...raw.agent?.memorySearch,
        embeddings: {
          ...defaults.agent.memorySearch?.embeddings,
          ...raw.agent?.memorySearch?.embeddings,
        },
      },
      memoryFlush: {
        ...defaults.agent.memoryFlush,
        ...raw.agent?.memoryFlush,
      },
    };
    config.channels = {
      telegram: { ...defaults.channels.telegram, ...raw.channels?.telegram },
      cli: { ...defaults.channels.cli, ...raw.channels?.cli },
      dingtalk: { ...defaults.channels.dingtalk, ...raw.channels?.dingtalk },
      feishu: { ...defaults.channels.feishu, ...raw.channels?.feishu },
      qq: { ...defaults.channels.qq, ...raw.channels?.qq },
    };
  } else {
    config = structuredClone(defaults);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path, JSON.stringify(defaults, null, 2), "utf-8");
  }

  return envOverride(config);
}

export function watchConfig(baseDir: string, onChange: (config: Config) => void): FSWatcher {
  const path = configPath(baseDir);
  let debounce: ReturnType<typeof setTimeout> | null = null;
  return watch(path, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const config = loadConfig(baseDir);
        onChange(config);
        logger.info("config", "reloaded");
      } catch (e) {
        logger.error("config", "reload failed:", e);
      }
    }, 500);
  });
}

export function ensureWorkspaceDirs(workspace: string): void {
  const dirs = [
    workspace,
    join(workspace, "skills"),
    join(workspace, "memory"),
    join(workspace, "logs"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
