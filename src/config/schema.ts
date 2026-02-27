import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, mkdirSync, writeFileSync, watch, type FSWatcher } from "fs";
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

export interface ChannelsConfig {
  telegram: TelegramConfig;
  cli: CliConfig;
}

export interface AgentConfig {
  model: string;
  codeModel?: string;
  temperature: number;
  maxTokens: number;
  memoryWindow: number;
  workspace: string;
  maxMemorySize?: number;
  consolidationTimeout?: number;
}

export interface ProviderConfig {
  api: string;
  options?: Record<string, unknown>;
  models?: Record<string, string>;
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
      model: "anthropic/claude-sonnet-4-20250514",
      temperature: 0.7,
      maxTokens: 4096,
      memoryWindow: 50,
      workspace: join(baseDir, "workspace"),
      maxMemorySize: 8192,
      consolidationTimeout: 30000,
    },
    channels: {
      telegram: { enabled: false, token: "", allowFrom: [] },
      cli: { enabled: true },
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
