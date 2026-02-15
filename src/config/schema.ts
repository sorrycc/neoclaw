import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";

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
  temperature: number;
  maxTokens: number;
  memoryWindow: number;
  workspace: string;
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
}

const DEFAULT_BASE = join(homedir(), ".neoclaw");

const DEFAULT_CONFIG: Config = {
  agent: {
    model: "anthropic/claude-sonnet-4-20250514",
    temperature: 0.7,
    maxTokens: 4096,
    memoryWindow: 50,
    workspace: join(DEFAULT_BASE, "workspace"),
  },
  channels: {
    telegram: { enabled: false, token: "", allowFrom: [] },
    cli: { enabled: true },
  },
};

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

export function configPath(): string {
  return join(DEFAULT_BASE, "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  let config: Config;

  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    config = { ...DEFAULT_CONFIG, ...raw };
    config.agent = { ...DEFAULT_CONFIG.agent, ...raw.agent };
    config.channels = {
      telegram: { ...DEFAULT_CONFIG.channels.telegram, ...raw.channels?.telegram },
      cli: { ...DEFAULT_CONFIG.channels.cli, ...raw.channels?.cli },
    };
  } else {
    config = structuredClone(DEFAULT_CONFIG);
    mkdirSync(DEFAULT_BASE, { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }

  return envOverride(config);
}

export function ensureWorkspaceDirs(workspace: string): void {
  const dirs = [
    workspace,
    join(workspace, "skills"),
    join(workspace, "memory"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
