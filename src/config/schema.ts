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

export interface ChannelsConfig {
  telegram: TelegramConfig;
  cli: CliConfig;
  dingtalk: DingtalkConfig;
}

export interface AgentConfig {
  model: string;
  codeModel?: string;
  memoryWindow: number;
  workspace: string;
  maxMemorySize?: number;
  consolidationTimeout?: number;
  subagentTimeout?: number;
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
      consolidationTimeout: 30000,
    },
    channels: {
      telegram: { enabled: false, token: "", allowFrom: [] },
      cli: { enabled: true },
      dingtalk: { enabled: false, clientId: "", clientSecret: "", robotCode: "", allowFrom: [] },
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
    config.agent = { ...defaults.agent, ...raw.agent };
    config.channels = {
      telegram: { ...defaults.channels.telegram, ...raw.channels?.telegram },
      cli: { ...defaults.channels.cli, ...raw.channels?.cli },
      dingtalk: { ...defaults.channels.dingtalk, ...raw.channels?.dingtalk },
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
