import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawnSync } from "child_process";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  createReadStream,
  readdirSync,
  rmSync,
} from "fs";
import { join, extname, resolve, dirname, basename, sep } from "path";
import { fileURLToPath } from "url";
import { createSession } from "@neovate/code";

let _headlessSession: any = null;
async function getHeadlessBus(cwd: string) {
  if (!_headlessSession) {
    _headlessSession = await createSession({
      model: "openai:gpt-4o",
      cwd,
      providers: {}
    });
  }
  return _headlessSession.messageBus;
}
import { configPath, loadConfig, type Config } from "../config/schema.js";
import { logger } from "../logger.js";
import { readRuntimeStatusSnapshot } from "../runtime/status-store.js";

type WebOptions = {
  baseDir: string;
  host?: string;
  port?: number;
  token?: string;
  autoStart?: WebAutoStartOptions;
};

type WebAutoStartOptions = {
  enabled: boolean;
  startArgs?: string[];
  cwd?: string;
  projectRoot?: string;
  useBunRuntime?: boolean;
};

type JsonBody = Record<string, unknown>;
type CommandRunnerResult = { status: number | null; error?: Error };
type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandRunnerResult;
type EnsureWebUiBuiltOptions = {
  runner?: CommandRunner;
  projectRoot?: string;
  cwd?: string;
};

type RateState = { count: number; resetAt: number };
type ModelOption = { label: string; value: string };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CustomApiFormat = "openai" | "responses" | "anthropic" | "google";

export type AutoStartCommand = {
  mode: "bun" | "neoclaw";
  cmd: string;
  args: string[];
  cwd: string;
  display: string;
};

export type AutoStartResult = {
  enabled: boolean;
  started: boolean;
  alreadyStarted?: boolean;
  command?: string;
  mode?: "bun" | "neoclaw";
  pid?: number;
  error?: string;
};

export type ConfigSaveResult = {
  ok: boolean;
  warning: string;
  startCommand?: string;
  config: Config;
};

export type WebCommandResult = {
  startAgent: boolean;
};

const BODY_LIMIT = 1024 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "../..");
const SNAPSHOT_MAX_FILES = 30;

export interface ConfigSnapshotMeta {
  id: string;
  createdAt: string;
  size: number;
  reason: string;
}

export interface ConfigSnapshotPreview {
  snapshot: ConfigSnapshotMeta;
  config: Config;
}

function createRateLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const state = new Map<string, RateState>();
  return (key: string) => {
    const now = Date.now();
    const entry = state.get(key);
    if (!entry || entry.resetAt <= now) {
      state.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}

function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const chunk of cookieHeader.split(";")) {
    const idx = chunk.indexOf("=");
    if (idx <= 0) continue;
    const k = chunk.slice(0, idx).trim();
    const v = chunk.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  setSecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  setSecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveStatic(res: ServerResponse, filePath: string): void {
  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const stat = statSync(filePath);

    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    createReadStream(filePath).pipe(res);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found" });
    } else {
      sendJson(res, 500, { error: "Internal Error" });
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > BODY_LIMIT) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        if (!raw) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("JSON body must be an object"));
          return;
        }
        resolve(parsed as JsonBody);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function resolveWebDistDir(projectRoot = PROJECT_ROOT, cwd = process.cwd()): string | null {
  const candidates = [
    resolve(projectRoot, "dist/web"),
    resolve(projectRoot, "webapp/dist"),
    resolve(cwd, "dist/web"),
    resolve(cwd, "webapp/dist"),
  ];
  for (const candidate of candidates) {
    const index = join(candidate, "index.html");
    if (existsSync(index)) return candidate;
  }
  return null;
}

function hasWebBuildDependencies(projectRoot = PROJECT_ROOT): boolean {
  const webappRoot = resolve(projectRoot, "webapp");
  return [
    join(webappRoot, "node_modules", "vite", "package.json"),
    join(webappRoot, "node_modules", "typescript", "package.json"),
    join(webappRoot, "node_modules", "@vitejs", "plugin-react", "package.json"),
  ].every((path) => existsSync(path));
}

function assertCommandSucceeded(command: string, result: CommandRunnerResult): void {
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Failed to run ${command}: exited with code ${result.status ?? "unknown"}`);
  }
}

function defaultCommandRunner(cmd: string, args: string[], cwd: string): CommandRunnerResult {
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  return {
    status: result.status,
    error: result.error,
  };
}

function quoteShellArg(arg: string): string {
  return /[^A-Za-z0-9_./:-]/.test(arg) ? JSON.stringify(arg) : arg;
}

function isPidRunning(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readActiveAgentPid(baseDir: string): number | undefined {
  const snapshot = readRuntimeStatusSnapshot(baseDir);
  const pid = snapshot.agent.pid;
  if (!snapshot.agent.running || !isPidRunning(pid)) return undefined;
  return pid ?? undefined;
}

export function resolveAutoStartCommand(options: {
  startArgs?: string[];
  cwd?: string;
  projectRoot?: string;
  useBunRuntime?: boolean;
} = {}): AutoStartCommand {
  const startArgs = options.startArgs ?? [];
  const useBunRuntime = options.useBunRuntime ?? typeof process.versions.bun === "string";

  if (useBunRuntime) {
    const args = startArgs.length > 0 ? ["run", "start", "--", ...startArgs] : ["run", "start"];
    return {
      mode: "bun",
      cmd: "bun",
      args,
      cwd: options.projectRoot ?? PROJECT_ROOT,
      display: ["bun", ...args].map(quoteShellArg).join(" "),
    };
  }

  return {
    mode: "neoclaw",
    cmd: "neoclaw",
    args: startArgs,
    cwd: options.cwd ?? process.cwd(),
    display: ["neoclaw", ...startArgs].map(quoteShellArg).join(" "),
  };
}

export async function triggerAutoStart(
  baseDir: string,
  options: WebAutoStartOptions | undefined,
) : Promise<AutoStartResult> {
  if (!options?.enabled) return { enabled: false, started: false };

  const command = resolveAutoStartCommand({
    startArgs: options.startArgs,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    useBunRuntime: options.useBunRuntime,
  });

  const activePid = readActiveAgentPid(baseDir);
  if (activePid) {
    return {
      enabled: true,
      started: false,
      alreadyStarted: true,
      command: command.display,
      mode: command.mode,
      pid: activePid,
    };
  }

  return {
    enabled: true,
    started: true,
    command: command.display,
    mode: command.mode,
  };
}

export function ensureWebUiBuilt(options: EnsureWebUiBuiltOptions = {}): string {
  const {
    runner = defaultCommandRunner,
    projectRoot = PROJECT_ROOT,
    cwd = process.cwd(),
  } = options;

  const distDir = resolveWebDistDir(projectRoot, cwd);
  const webappRoot = resolve(projectRoot, "webapp");
  const hasWebappSource = existsSync(join(webappRoot, "package.json"));

  if (!hasWebappSource) {
    if (distDir) return distDir;
    throw new Error(`Failed to build Web UI: webapp package not found at ${webappRoot}`);
  }

  if (!hasWebBuildDependencies(projectRoot)) {
    logger.info("web", "web build dependencies not found, running `bun install` in webapp");
    const installResult = runner("bun", ["install"], webappRoot);
    assertCommandSucceeded("`bun install` in webapp", installResult);
  }

  logger.info("web", distDir
    ? "rebuilding web ui on startup to pick up frontend changes"
    : "web ui not found, running `bun run build:web`");
  const result = runner("bun", ["run", "build:web"], projectRoot);
  assertCommandSucceeded("`bun run build:web`", result);

  const builtDistDir = resolveWebDistDir(projectRoot, cwd);
  if (!builtDistDir) {
    throw new Error("Failed to build Web UI: build completed but index.html is still missing");
  }

  return builtDistDir;
}

function safeResolveInDist(distRoot: string, pathname: string): string | null {
  const rel = pathname.replace(/^\/+/, "");
  const target = resolve(distRoot, rel || "index.html");
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return null;
  return target;
}

function snapshotDir(baseDir: string): string {
  return join(baseDir, "snapshots", "config");
}

function normalizeSnapshotId(id: string): string {
  const safe = basename(id).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.endsWith(".json") ? safe : `${safe}.json`;
}

function snapshotFilePath(baseDir: string, id: string): string {
  return join(snapshotDir(baseDir), normalizeSnapshotId(id));
}

function parseSnapshotReason(id: string): string {
  const base = basename(id, ".json");
  const match = base.match(/^\d{8}-\d+-(.+)-\d+$/);
  return match?.[1]?.trim() || "manual";
}

export function listConfigSnapshots(baseDir: string): ConfigSnapshotMeta[] {
  const dir = snapshotDir(baseDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const st = statSync(join(dir, name));
      return {
        id: name,
        createdAt: st.mtime.toISOString(),
        size: st.size,
        reason: parseSnapshotReason(name),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneSnapshots(baseDir: string): void {
  const list = listConfigSnapshots(baseDir);
  if (list.length <= SNAPSHOT_MAX_FILES) return;
  for (const snap of list.slice(SNAPSHOT_MAX_FILES)) {
    try {
      rmSync(snapshotFilePath(baseDir, snap.id), { force: true });
    } catch {}
  }
}

export function createConfigSnapshot(baseDir: string, config: Config, reason: string): ConfigSnapshotMeta {
  const dir = snapshotDir(baseDir);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace("Z", "")
    .replace(".", "");
  const suffix = reason.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "manual";
  const id = `${stamp}-${suffix}-${Math.floor(Math.random() * 1000)}.json`;
  const file = snapshotFilePath(baseDir, id);
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
  const st = statSync(file);
  pruneSnapshots(baseDir);
  return {
    id,
    createdAt: st.mtime.toISOString(),
    size: st.size,
    reason,
  };
}

export function readSnapshotConfig(baseDir: string, id: string): Config {
  const file = snapshotFilePath(baseDir, id);
  return JSON.parse(readFileSync(file, "utf-8")) as Config;
}

export function readConfigSnapshotPreview(baseDir: string, id: string): ConfigSnapshotPreview {
  const normalizedId = normalizeSnapshotId(id);
  const snapshot = listConfigSnapshots(baseDir).find((entry) => entry.id === normalizedId);
  if (!snapshot) {
    throw new Error("snapshot not found");
  }
  return {
    snapshot,
    config: maskConfig(readSnapshotConfig(baseDir, normalizedId)),
  };
}

function mergeImportedConfig(current: Config, incoming: unknown): Config {
  const body = (incoming && typeof incoming === "object" ? incoming : {}) as Record<string, unknown>;
  const payload =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : body;

  const channelsRaw =
    payload.channels && typeof payload.channels === "object" && !Array.isArray(payload.channels)
      ? (payload.channels as Record<string, unknown>)
      : {};
  const agentRaw =
    payload.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent)
      ? (payload.agent as Record<string, unknown>)
      : {};

  const next = {
    ...current,
    ...(payload as Partial<Config>),
    agent: {
      ...current.agent,
      ...(agentRaw as Partial<Config["agent"]>),
    },
    channels: {
      ...current.channels,
      ...(channelsRaw as Partial<Config["channels"]>),
      telegram: {
        ...current.channels.telegram,
        ...((channelsRaw.telegram as Partial<Config["channels"]["telegram"]>) || {}),
      },
      cli: {
        ...current.channels.cli,
        ...((channelsRaw.cli as Partial<Config["channels"]["cli"]>) || {}),
      },
      dingtalk: {
        ...current.channels.dingtalk,
        ...((channelsRaw.dingtalk as Partial<Config["channels"]["dingtalk"]>) || {}),
      },
      feishu: {
        ...current.channels.feishu,
        ...((channelsRaw.feishu as Partial<Config["channels"]["feishu"]>) || {}),
      },
      qq: {
        ...current.channels.qq,
        ...((channelsRaw.qq as Partial<Config["channels"]["qq"]>) || {}),
      },
    },
    providers:
      payload.providers !== undefined
        ? (payload.providers as Config["providers"])
        : current.providers,
  };

  return next;
}

export function buildOpenAiCompatibleModelsUrl(baseURL: string): string {
  const raw = baseURL.trim();
  if (!raw) throw new Error("baseURL required");
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/models") ? pathname : `${pathname || ""}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildCustomModelsUrl(baseURL: string, apiFormat: CustomApiFormat): string {
  if (apiFormat === "openai" || apiFormat === "responses" || apiFormat === "anthropic" || apiFormat === "google") {
    return buildOpenAiCompatibleModelsUrl(baseURL);
  }
  return buildOpenAiCompatibleModelsUrl(baseURL);
}

function toModelOptions(providerId: string, modelIds: string[]): ModelOption[] {
  return modelIds.map((modelId) => ({
    label: modelId,
    value: `${providerId}/${modelId}`,
  }));
}

function toCustomProviderModelsMap(models: ModelOption[]): Record<string, string> {
  const entries = models
    .map((model) => {
      const slash = model.value.indexOf("/");
      const modelId = slash >= 0 ? model.value.slice(slash + 1) : model.value;
      return modelId.trim() ? [modelId, modelId] : null;
    })
    .filter((entry): entry is [string, string] => Array.isArray(entry));
  return Object.fromEntries(entries);
}

export async function discoverOpenAiCompatibleModels(
  providerId: string,
  baseURL: string,
  apiKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<ModelOption[]> {
  return discoverCustomProviderModels(providerId, baseURL, "openai", apiKey, fetchImpl);
}

function readCustomModelIds(payload: unknown, apiFormat: CustomApiFormat): string[] {
  if (!payload || typeof payload !== "object") return [];

  const source = apiFormat === "google"
    ? (payload as { models?: Array<{ name?: unknown; displayName?: unknown } | string> }).models
    : (payload as { data?: Array<{ id?: unknown; name?: unknown } | string> }).data;

  return Array.from(new Set((source || [])
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (apiFormat === "google") {
        const rawName = typeof entry?.name === "string" ? entry.name.trim() : "";
        return rawName.replace(/^models\//, "");
      }
      const candidate = entry as { id?: unknown; name?: unknown };
      if (typeof candidate.id === "string") return candidate.id.trim();
      return typeof candidate.name === "string" ? candidate.name.trim() : "";
    })
    .filter(Boolean)));
}

export async function discoverCustomProviderModels(
  providerId: string,
  baseURL: string,
  apiFormat: CustomApiFormat,
  apiKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<ModelOption[]> {
  const url = new URL(buildCustomModelsUrl(baseURL, apiFormat));
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = apiKey?.trim();
  if (token) {
    if (apiFormat === "anthropic") {
      headers["x-api-key"] = token;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiFormat === "google") {
      url.searchParams.set("key", token);
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (apiFormat === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === "string"
        ? body.error
        : body.error?.message || body.message || "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(detail || `models endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const ids = readCustomModelIds(payload, apiFormat);

  if (ids.length === 0) {
    throw new Error(`${apiFormat} endpoint returned no models`);
  }

  return toModelOptions(providerId, ids);
}

async function listDraftProviderModels(baseDir: string, providerId: string, options?: { apiKey?: string; baseURL?: string }): Promise<ModelOption[]> {
  const session = await createSession({
    model: "openai:gpt-4o",
    cwd: baseDir,
    providers: options && (options.apiKey?.trim() || options.baseURL?.trim())
      ? {
          [providerId]: {
            id: providerId,
            options: {
              ...(options.apiKey?.trim() ? { apiKey: options.apiKey.trim() } : {}),
              ...(options.baseURL?.trim() ? { baseURL: options.baseURL.trim() } : {}),
            },
          },
        }
      : {},
  });

  try {
    const bus = (session as any).messageBus;
    const mRes = await bus.request("models.list", { cwd: baseDir });
    if (!mRes.success) throw new Error(mRes.error || "models.list failed");
    const group = (mRes.data?.groupedModels || []).find((g: any) => g.provider === providerId || g.providerId === providerId);
    const result = group?.models || [];
    return result.map((x: any) => ({ label: x.name || x.id, value: x.value || x.id }));
  } finally {
    await session.close();
  }
}

function maskConfig(config: Config): Config {
  const clone = structuredClone(config);
  if (clone.channels.telegram.token) clone.channels.telegram.token = "********";
  if (clone.channels.dingtalk.clientSecret) clone.channels.dingtalk.clientSecret = "********";
  if (clone.channels.feishu.appSecret) clone.channels.feishu.appSecret = "********";
  if (clone.channels.qq.clientSecret) clone.channels.qq.clientSecret = "********";
  if (clone.agent.memorySearch) delete clone.agent.memorySearch;
  if (clone.agent.memoryFlush) delete clone.agent.memoryFlush;
  return clone;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeIncomingConfig(body: JsonBody, baseDir: string): Config {
  const current = loadConfig(baseDir);
  const next = structuredClone(current);

  const agent = (body.agent ?? {}) as JsonBody;
  const memorySearch = (agent.memorySearch ?? {}) as JsonBody;
  const memoryEmbeddings = (memorySearch.embeddings ?? {}) as JsonBody;
  const memoryFlush = (agent.memoryFlush ?? {}) as JsonBody;
  const channels = (body.channels ?? {}) as JsonBody;
  const telegram = (channels.telegram ?? {}) as JsonBody;
  const cli = (channels.cli ?? {}) as JsonBody;
  const dingtalk = (channels.dingtalk ?? {}) as JsonBody;
  const feishu = (channels.feishu ?? {}) as JsonBody;
  const qq = (channels.qq ?? {}) as JsonBody;

  if (typeof agent.model === "string") next.agent.model = agent.model.trim();
  if (typeof agent.codeModel === "string") next.agent.codeModel = agent.codeModel.trim();
  if (typeof agent.memoryWindow === "number") next.agent.memoryWindow = Math.max(1, Math.floor(agent.memoryWindow));
  if (typeof agent.workspace === "string") next.agent.workspace = agent.workspace.trim();
  if (typeof agent.maxMemorySize === "number") next.agent.maxMemorySize = Math.max(1024, Math.floor(agent.maxMemorySize));
  if (typeof agent.consolidationTimeout === "number") next.agent.consolidationTimeout = Math.max(1000, Math.floor(agent.consolidationTimeout));
  if (typeof agent.subagentTimeout === "number") next.agent.subagentTimeout = Math.max(1000, Math.floor(agent.subagentTimeout));
  if (typeof memorySearch.enabled === "boolean") next.agent.memorySearch = { ...next.agent.memorySearch, enabled: memorySearch.enabled };
  if (memorySearch.provider === "fts" || memorySearch.provider === "hybrid") next.agent.memorySearch = { ...next.agent.memorySearch, provider: memorySearch.provider };
  if (typeof memorySearch.maxResults === "number") next.agent.memorySearch = { ...next.agent.memorySearch, maxResults: Math.max(1, Math.floor(memorySearch.maxResults)) };
  if (typeof memorySearch.minScore === "number") next.agent.memorySearch = { ...next.agent.memorySearch, minScore: memorySearch.minScore };
  if (typeof memorySearch.indexPath === "string") next.agent.memorySearch = { ...next.agent.memorySearch, indexPath: memorySearch.indexPath.trim() };
  if (typeof memorySearch.autoRecall === "boolean") next.agent.memorySearch = { ...next.agent.memorySearch, autoRecall: memorySearch.autoRecall };
  if (typeof memorySearch.recencyHalfLifeDays === "number") next.agent.memorySearch = { ...next.agent.memorySearch, recencyHalfLifeDays: Math.max(1, Math.floor(memorySearch.recencyHalfLifeDays)) };
  if (typeof memoryEmbeddings.enabled === "boolean") next.agent.memorySearch = { ...next.agent.memorySearch, embeddings: { ...next.agent.memorySearch?.embeddings, enabled: memoryEmbeddings.enabled } };
  if (typeof memoryEmbeddings.model === "string") next.agent.memorySearch = { ...next.agent.memorySearch, embeddings: { ...next.agent.memorySearch?.embeddings, model: memoryEmbeddings.model.trim() } };
  if (typeof memoryEmbeddings.dims === "number") next.agent.memorySearch = { ...next.agent.memorySearch, embeddings: { ...next.agent.memorySearch?.embeddings, dims: Math.max(1, Math.floor(memoryEmbeddings.dims)) } };
  if (typeof memoryFlush.enabled === "boolean") next.agent.memoryFlush = { ...next.agent.memoryFlush, enabled: memoryFlush.enabled };
  if (typeof memoryFlush.timeoutMs === "number") next.agent.memoryFlush = { ...next.agent.memoryFlush, timeoutMs: Math.max(1000, Math.floor(memoryFlush.timeoutMs)) };

  if (typeof telegram.enabled === "boolean") next.channels.telegram.enabled = telegram.enabled;
  if (typeof telegram.token === "string" && telegram.token.trim() && telegram.token.trim() !== "********") {
    next.channels.telegram.token = telegram.token.trim();
  }
  if (telegram.allowFrom !== undefined) next.channels.telegram.allowFrom = parseStringArray(telegram.allowFrom);
  if (typeof telegram.proxy === "string") next.channels.telegram.proxy = telegram.proxy.trim();

  if (typeof cli.enabled === "boolean") next.channels.cli.enabled = cli.enabled;

  if (typeof dingtalk.enabled === "boolean") next.channels.dingtalk.enabled = dingtalk.enabled;
  if (typeof dingtalk.clientId === "string") next.channels.dingtalk.clientId = dingtalk.clientId.trim();
  if (typeof dingtalk.clientSecret === "string" && dingtalk.clientSecret.trim() && dingtalk.clientSecret.trim() !== "********") {
    next.channels.dingtalk.clientSecret = dingtalk.clientSecret.trim();
  }
  if (typeof dingtalk.robotCode === "string") next.channels.dingtalk.robotCode = dingtalk.robotCode.trim();
  if (typeof dingtalk.corpId === "string") next.channels.dingtalk.corpId = dingtalk.corpId.trim();
  if (dingtalk.allowFrom !== undefined) next.channels.dingtalk.allowFrom = parseStringArray(dingtalk.allowFrom);
  if (typeof dingtalk.keepAlive === "boolean") next.channels.dingtalk.keepAlive = dingtalk.keepAlive;

  if (typeof feishu.enabled === "boolean") next.channels.feishu.enabled = feishu.enabled;
  if (typeof feishu.appId === "string") next.channels.feishu.appId = feishu.appId.trim();
  if (typeof feishu.appSecret === "string" && feishu.appSecret.trim() && feishu.appSecret.trim() !== "********") {
    next.channels.feishu.appSecret = feishu.appSecret.trim();
  }
  if (feishu.allowFrom !== undefined) next.channels.feishu.allowFrom = parseStringArray(feishu.allowFrom);
  if (typeof feishu.domain === "string") next.channels.feishu.domain = feishu.domain.trim();
  if (feishu.connectionMode === "websocket" || feishu.connectionMode === "webhook") {
    next.channels.feishu.connectionMode = feishu.connectionMode;
  }
  if (typeof feishu.encryptKey === "string") next.channels.feishu.encryptKey = feishu.encryptKey.trim();
  if (typeof feishu.verificationToken === "string") next.channels.feishu.verificationToken = feishu.verificationToken.trim();
  if (typeof feishu.webhookHost === "string") next.channels.feishu.webhookHost = feishu.webhookHost.trim();
  if (typeof feishu.webhookPort === "number") {
    const n = Math.floor(feishu.webhookPort);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.webhookPort = n;
  }
  if (typeof feishu.webhookPath === "string") next.channels.feishu.webhookPath = feishu.webhookPath.trim();
  if (typeof feishu.requireMention === "boolean") next.channels.feishu.requireMention = feishu.requireMention;
  if (typeof feishu.webhookMaxBodyBytes === "number") {
    const n = Math.floor(feishu.webhookMaxBodyBytes);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.webhookMaxBodyBytes = n;
  }
  if (typeof feishu.webhookBodyTimeoutMs === "number") {
    const n = Math.floor(feishu.webhookBodyTimeoutMs);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.webhookBodyTimeoutMs = n;
  }
  if (typeof feishu.webhookRateLimitPerMin === "number") {
    const n = Math.floor(feishu.webhookRateLimitPerMin);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.webhookRateLimitPerMin = n;
  }
  if (typeof feishu.wsReconnectBaseMs === "number") {
    const n = Math.floor(feishu.wsReconnectBaseMs);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.wsReconnectBaseMs = n;
  }
  if (typeof feishu.wsReconnectMaxMs === "number") {
    const n = Math.floor(feishu.wsReconnectMaxMs);
    if (Number.isFinite(n) && n > 0) next.channels.feishu.wsReconnectMaxMs = n;
  }
  if (typeof feishu.dedupPersist === "boolean") next.channels.feishu.dedupPersist = feishu.dedupPersist;
  if (typeof feishu.dedupFile === "string") next.channels.feishu.dedupFile = feishu.dedupFile.trim();

  if (typeof qq.enabled === "boolean") next.channels.qq.enabled = qq.enabled;
  if (typeof qq.appId === "string") next.channels.qq.appId = qq.appId.trim();
  if (typeof qq.clientSecret === "string" && qq.clientSecret.trim() && qq.clientSecret.trim() !== "********") {
    next.channels.qq.clientSecret = qq.clientSecret.trim();
  }
  if (qq.allowFrom !== undefined) next.channels.qq.allowFrom = parseStringArray(qq.allowFrom);
  if (typeof qq.requireMention === "boolean") next.channels.qq.requireMention = qq.requireMention;
  if (typeof qq.apiBase === "string") next.channels.qq.apiBase = qq.apiBase.trim();
  if (typeof qq.wsIntentMask === "number") {
    const n = Math.floor(qq.wsIntentMask);
    if (Number.isFinite(n) && n > 0) next.channels.qq.wsIntentMask = n;
  }
  if (typeof qq.wsReconnectBaseMs === "number") {
    const n = Math.floor(qq.wsReconnectBaseMs);
    if (Number.isFinite(n) && n > 0) next.channels.qq.wsReconnectBaseMs = n;
  }
  if (typeof qq.wsReconnectMaxMs === "number") {
    const n = Math.floor(qq.wsReconnectMaxMs);
    if (Number.isFinite(n) && n > 0) next.channels.qq.wsReconnectMaxMs = n;
  }
  if (typeof qq.dedupPersist === "boolean") next.channels.qq.dedupPersist = qq.dedupPersist;
  if (typeof qq.dedupFile === "string") next.channels.qq.dedupFile = qq.dedupFile.trim();

  if (body.providers !== undefined && typeof body.providers === "object" && body.providers && !Array.isArray(body.providers)) {
    next.providers = body.providers as Config["providers"];
  }
  if (typeof body.logLevel === "string") next.logLevel = body.logLevel.trim();

  return next;
}

function validateConfig(config: Config): string[] {
  const errs: string[] = [];
  if (!config.agent.model) errs.push("agent.model 不能为空");
  if (!config.agent.workspace) errs.push("agent.workspace 不能为空");
  if (config.agent.memoryWindow < 1) errs.push("agent.memoryWindow 必须 >= 1");
  if (config.agent.memorySearch?.maxResults !== undefined && config.agent.memorySearch.maxResults < 1) errs.push("agent.memorySearch.maxResults 必须 >= 1");
  if (config.agent.memorySearch?.recencyHalfLifeDays !== undefined && config.agent.memorySearch.recencyHalfLifeDays < 1) errs.push("agent.memorySearch.recencyHalfLifeDays 必须 >= 1");
  if (config.agent.memoryFlush?.timeoutMs !== undefined && config.agent.memoryFlush.timeoutMs < 1000) errs.push("agent.memoryFlush.timeoutMs 必须 >= 1000");
  if (config.channels.telegram.enabled && !config.channels.telegram.token) errs.push("Telegram 启用时必须设置 token");
  if (config.channels.dingtalk.enabled) {
    if (!config.channels.dingtalk.clientId) errs.push("DingTalk 启用时必须设置 clientId");
    if (!config.channels.dingtalk.clientSecret) errs.push("DingTalk 启用时必须设置 clientSecret");
    if (!config.channels.dingtalk.robotCode) errs.push("DingTalk 启用时必须设置 robotCode");
  }
  if (config.channels.feishu.enabled) {
    if (!config.channels.feishu.appId) errs.push("Feishu 启用时必须设置 appId");
    if (!config.channels.feishu.appSecret) errs.push("Feishu 启用时必须设置 appSecret");
    const mode = config.channels.feishu.connectionMode || "websocket";
    if (mode !== "websocket" && mode !== "webhook") errs.push("Feishu connectionMode 必须是 websocket 或 webhook");
    if (mode === "webhook" && !config.channels.feishu.verificationToken) {
      errs.push("Feishu 在 webhook 模式下必须设置 verificationToken");
    }
  }
  if (config.channels.qq.enabled) {
    if (!config.channels.qq.appId) errs.push("QQ 启用时必须设置 appId");
    if (!config.channels.qq.clientSecret) errs.push("QQ 启用时必须设置 clientSecret");
    if ((config.channels.qq.wsIntentMask || 0) <= 0) errs.push("QQ wsIntentMask 必须是正整数");
  }
  return errs;
}

async function chatProbe(config: Config, message: string): Promise<{ ok: boolean; response?: string; error?: string }> {
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    session = await createSession({
      model: config.agent.model,
      cwd: config.agent.workspace,
      providers: config.providers,
    });
    await session.send(message);

    let result = "";
    for await (const m of session.receive()) {
      if (m.type === "result") result = m.content;
    }
    if (!result) return { ok: false, error: "未收到模型返回内容" };
    return { ok: true, response: result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  } finally {
    session?.close();
  }
}

function renderPage(csrfToken: string): string {
  // Obsolete function. Left empty or to be removed if totally unused.
  return "";
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && safeTokenEqual(auth.slice(7), token)) return true;
  const cookieToken = parseCookies(req.headers.cookie).neoclaw_web_token;
  return typeof cookieToken === "string" && safeTokenEqual(cookieToken, token);
}

function isStateChanging(req: IncomingMessage): boolean {
  return req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
}

export async function handleWebCommand(opts: WebOptions): Promise<WebCommandResult> {
  const host = opts.host || "127.0.0.1";
  const port = opts.port || 3180;
  const accessToken = opts.token || process.env.NEOCLAW_WEB_TOKEN || randomBytes(18).toString("base64url");
  const csrfToken = randomBytes(18).toString("base64url");
  let startAgent = false;
  let closing = false;
  let resolveClosed: (() => void) | null = null;
  let server: ReturnType<typeof createServer>;

  const requestClose = () => {
    if (closing) return;
    closing = true;
    server.close(() => resolveClosed?.());
  };

  mkdirSync(opts.baseDir, { recursive: true });
  const distDir = ensureWebUiBuilt();

  const authLimiter = createRateLimiter(30, 60_000);
  const apiLimiter = createRateLimiter(300, 60_000);

  server = createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const ip = clientIp(req);

      if (!apiLimiter(ip)) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
      }

      if (url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/" && method === "GET") {
        if (!authLimiter(ip)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        const indexHtmlPath = join(distDir, "index.html");
        try {
          const indexHtml = readFileSync(indexHtmlPath, "utf-8");
          sendHtml(res, indexHtml.replace('__CSRF_TOKEN__', csrfToken));
        } catch (err) {
          sendHtml(res, "Web UI not built. Please run `bun run build:web`.");
        }
        return;
      }

      // Serve static assets for the React App
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/") && method === "GET") {
        const resolvedPath = safeResolveInDist(distDir, url.pathname);
        if (!resolvedPath) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        serveStatic(res, resolvedPath);
        return;
      }

      if (url.pathname === "/auth/login" && method === "POST") {
        if (!authLimiter(ip)) {
          sendJson(res, 429, { error: "Too many requests" });
          return;
        }
        const body = await readJsonBody(req);
        const token = typeof body.token === "string" ? body.token : "";
        if (!token || !safeTokenEqual(token, accessToken)) {
          sendJson(res, 401, { error: "无效 token" });
          return;
        }
        setSecurityHeaders(res);
        res.statusCode = 200;
        res.setHeader("Set-Cookie", [
          `neoclaw_web_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
          `csrf-token=${csrfToken}; SameSite=Strict; Path=/`
        ]);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!isAuthorized(req, accessToken)) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        if (isStateChanging(req)) {
          const csrf = req.headers["x-csrf-token"];
          if (typeof csrf !== "string" || !safeTokenEqual(csrf, csrfToken)) {
            sendJson(res, 403, { error: "Invalid CSRF token" });
            return;
          }
        }

        if (url.pathname === "/api/runtime-status" && method === "GET") {
          sendJson(res, 200, readRuntimeStatusSnapshot(opts.baseDir));
          return;
        }

        if (url.pathname === "/api/config/export" && method === "GET") {
          sendJson(res, 200, loadConfig(opts.baseDir));
          return;
        }

        if (url.pathname === "/api/config/snapshots" && method === "GET") {
          sendJson(res, 200, { snapshots: listConfigSnapshots(opts.baseDir) });
          return;
        }

        if (url.pathname.startsWith("/api/config/snapshots/") && method === "GET") {
          const snapshotId = decodeURIComponent(url.pathname.slice("/api/config/snapshots/".length));
          if (!snapshotId) {
            sendJson(res, 400, { error: "snapshot id required" });
            return;
          }
          try {
            sendJson(res, 200, readConfigSnapshotPreview(opts.baseDir, snapshotId));
          } catch {
            sendJson(res, 404, { error: "snapshot not found" });
          }
          return;
        }

        if (url.pathname === "/api/config/import" && method === "POST") {
          const body = await readJsonBody(req);
          const current = loadConfig(opts.baseDir);
          const next = mergeImportedConfig(current, body);
          const errors = validateConfig(next);
          if (errors.length > 0) {
            sendJson(res, 400, { error: "配置不合法", details: errors });
            return;
          }
          const snapshot = createConfigSnapshot(opts.baseDir, current, "before-import");
          writeFileSync(configPath(opts.baseDir), JSON.stringify(next, null, 2), "utf-8");
          sendJson(res, 200, { ok: true, snapshot, config: maskConfig(loadConfig(opts.baseDir)) });
          return;
        }

        if (url.pathname === "/api/config/rollback" && method === "POST") {
          const body = await readJsonBody(req);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "snapshot id required" });
            return;
          }
          const current = loadConfig(opts.baseDir);
          let target: Config;
          try {
            target = readSnapshotConfig(opts.baseDir, id);
          } catch {
            sendJson(res, 404, { error: "snapshot not found" });
            return;
          }
          const errors = validateConfig(target);
          if (errors.length > 0) {
            sendJson(res, 400, { error: "配置不合法", details: errors });
            return;
          }
          const backup = createConfigSnapshot(opts.baseDir, current, "before-rollback");
          writeFileSync(configPath(opts.baseDir), JSON.stringify(target, null, 2), "utf-8");
          sendJson(res, 200, { ok: true, backup, config: maskConfig(loadConfig(opts.baseDir)) });
          return;
        }

        if (url.pathname === "/api/providers/list" && method === "GET") {
          const bus = await getHeadlessBus(opts.baseDir);
          const listRes = await bus.request("providers.list", { cwd: opts.baseDir });
          const list = listRes.data?.providers || [];
          const normalized = list.map((p: any) => {
            // Default to 'api-key' for all providers, except oauth explicitly.
            let authType = 'api-key';
            if (['github-copilot', 'qwen', 'codex'].includes(p.id)) authType = 'oauth';
            return {
              ...p,
              authType
            }
          });
          // Also append an explicit "custom" marker option
          normalized.push({
            id: "custom",
            name: "自定义 / 其他 API",
            authType: "custom",
            source: "custom",
            api: "custom",
            hasApiKey: true,
            apiFormat: "openai",
            env: "NEOCLAW_API_KEY",
            apiEnv: "NEOCLAW_API_BASE",
          });
          sendJson(res, 200, { providers: normalized });
          return;
        }

        if (url.pathname === "/api/providers/auth/start" && method === "POST") {
          const body = await readJsonBody(req);
          const providerId = body.providerId as string;
          if (!providerId) { sendJson(res, 400, { error: "providerId required" }); return; }
          try {
            const bus = await getHeadlessBus(opts.baseDir);
            const resultRes = await bus.request("providers.login.initOAuth", { cwd: opts.baseDir, providerId });
            if (!resultRes.success) throw new Error(resultRes.error || "OAuth init failed");
            sendJson(res, 200, resultRes.data);
          } catch (e: any) {
            sendJson(res, 500, { error: e.message || String(e) });
          }
          return;
        }

        if (url.pathname === "/api/providers/auth/poll" && method === "POST") {
          const body = await readJsonBody(req);
          const { oauthSessionId } = body;
          try {
            const bus = await getHeadlessBus(opts.baseDir);
            const resultRes = await bus.request("providers.login.pollOAuth", { cwd: opts.baseDir, oauthSessionId });
            if (!resultRes.success) throw new Error(resultRes.error || "OAuth poll failed");
            sendJson(res, 200, resultRes.data);
          } catch (e: any) {
            sendJson(res, 500, { error: e.message || String(e) });
          }
          return;
        }

        if (url.pathname === "/api/providers/auth/complete" && method === "POST") {
          const body = await readJsonBody(req);
          try {
            const bus = await getHeadlessBus(opts.baseDir);
            const resultRes = await bus.request("providers.login.completeOAuth", {
              cwd: opts.baseDir,
              providerId: body.providerId as string,
              oauthSessionId: body.oauthSessionId as string,
              code: body.code as string
            });
            if (!resultRes.success) throw new Error(resultRes.error || "OAuth complete failed");
            sendJson(res, 200, resultRes.data);
          } catch (e: any) {
            sendJson(res, 500, { error: e.message || String(e) });
          }
          return;
        }

        if (url.pathname === "/api/providers/models" && method === "POST") {
          const body = await readJsonBody(req);
          try {
            if (body.mode === "custom") {
              const cp = body.customProvider as any;
              const providerId = typeof cp?.id === "string" ? cp.id.trim() : "";
              const apiFormat = typeof cp?.apiFormat === "string" ? cp.apiFormat.trim() as CustomApiFormat : "openai";
              const baseURL = typeof cp?.options?.baseURL === "string" ? cp.options.baseURL.trim() : "";
              const apiKey = typeof cp?.options?.apiKey === "string" ? cp.options.apiKey : undefined;
              if (!providerId) throw new Error("custom provider id required");
              if (!baseURL) throw new Error("custom provider baseURL required");
              const models = await discoverCustomProviderModels(providerId, baseURL, apiFormat, apiKey);
              sendJson(res, 200, {
                models,
                provider: {
                  ...cp,
                  id: providerId,
                  api: apiFormat,
                  apiFormat,
                  options: {
                    ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
                    baseURL,
                  },
                  models: toCustomProviderModelsMap(models),
                },
              });
            } else {
              const pid = body.providerId as string;
              const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
              const baseURL = typeof body.baseURL === "string" ? body.baseURL : undefined;
              const models = await listDraftProviderModels(opts.baseDir, pid, { apiKey, baseURL });
              sendJson(res, 200, { models });
            }
          } catch (e: any) {
            sendJson(res, 500, { error: e.message || String(e) });
          }
          return;
        }

        if (url.pathname === "/api/config/current" && method === "GET") {
          res.setHeader("Set-Cookie", `csrf-token=${csrfToken}; SameSite=Strict; Path=/`);
          const config = loadConfig(opts.baseDir);
          sendJson(res, 200, { config: maskConfig(config), isConfigured: !!config.agent.model });
          return;
        }

        if (url.pathname === "/api/config/test" && method === "POST") {
          const body = await readJsonBody(req);
          const incoming = normalizeIncomingConfig(body, opts.baseDir);
          const errors = validateConfig(incoming);
          sendJson(res, 200, { ok: errors.length === 0, errors });
          return;
        }

        if (url.pathname === "/api/config/save" && method === "POST") {
          const body = await readJsonBody(req);
          const incoming = normalizeIncomingConfig(body, opts.baseDir);
          const errors = validateConfig(incoming);
          if (errors.length > 0) {
            sendJson(res, 400, { error: "配置不合法", details: errors });
            return;
          }

          writeFileSync(configPath(opts.baseDir), JSON.stringify(incoming, null, 2), "utf-8");
          const startCommand = opts.autoStart?.enabled
            ? resolveAutoStartCommand({
                startArgs: opts.autoStart.startArgs,
                cwd: opts.autoStart.cwd,
                projectRoot: opts.autoStart.projectRoot,
                useBunRuntime: opts.autoStart.useBunRuntime,
              }).display
            : undefined;
          sendJson(res, 200, {
            ok: true,
            warning: "配置已写入。启动 Agent 前，可先在当前页面测试模型连通性。",
            startCommand,
            config: maskConfig(loadConfig(opts.baseDir)),
          } satisfies ConfigSaveResult);
          return;
        }

        if (url.pathname === "/api/agent/start" && method === "POST") {
          const started = await triggerAutoStart(opts.baseDir, opts.autoStart);
          sendJson(res, started.error ? 500 : 200, started);
          if (started.started && !started.alreadyStarted) {
            startAgent = true;
            setImmediate(requestClose);
          }
          return;
        }

        if (url.pathname === "/api/chat/test" && method === "POST") {
          const body = await readJsonBody(req);
          const payload = (body.config ?? {}) as JsonBody;
          const incoming = normalizeIncomingConfig(payload, opts.baseDir);
          const errors = validateConfig(incoming);
          if (errors.length > 0) {
            sendJson(res, 400, { ok: false, error: "配置不合法", details: errors });
            return;
          }
          const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "ping";
          const result = await chatProbe(incoming, message);
          sendJson(res, result.ok ? 200 : 500, result);
          return;
        }

        sendJson(res, 404, { error: "Not found" });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      logger.error("web", "request failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  logger.info("web", `config ui ready at http://${host}:${port}`);
  logger.info("web", `auth token: ${accessToken}`);
  logger.info("web", `use header: Authorization: Bearer <token>`);

  await new Promise<void>((resolve) => {
    resolveClosed = resolve;
    const close = () => requestClose();
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  });

  return { startAgent };
}

export function parseWebHost(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || "127.0.0.1";
}

export function parseWebPort(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return 8788;
  return Math.floor(n);
}

export function hasConfigFile(baseDir: string): boolean {
  try {
    readFileSync(configPath(baseDir), "utf-8");
    return true;
  } catch {
    return false;
  }
}
