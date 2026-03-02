import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, statSync, createReadStream } from "fs";
import { join, extname } from "path";
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

type WebOptions = {
  baseDir: string;
  host?: string;
  port?: number;
  token?: string;
};

type JsonBody = Record<string, unknown>;

type RateState = { count: number; resetAt: number };

const BODY_LIMIT = 1024 * 1024;

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

function maskConfig(config: Config): Config {
  const clone = structuredClone(config);
  if (clone.channels.telegram.token) clone.channels.telegram.token = "********";
  if (clone.channels.dingtalk.clientSecret) clone.channels.dingtalk.clientSecret = "********";
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
  const channels = (body.channels ?? {}) as JsonBody;
  const telegram = (channels.telegram ?? {}) as JsonBody;
  const cli = (channels.cli ?? {}) as JsonBody;
  const dingtalk = (channels.dingtalk ?? {}) as JsonBody;

  if (typeof agent.model === "string") next.agent.model = agent.model.trim();
  if (typeof agent.codeModel === "string") next.agent.codeModel = agent.codeModel.trim();
  if (typeof agent.memoryWindow === "number") next.agent.memoryWindow = Math.max(1, Math.floor(agent.memoryWindow));
  if (typeof agent.workspace === "string") next.agent.workspace = agent.workspace.trim();
  if (typeof agent.maxMemorySize === "number") next.agent.maxMemorySize = Math.max(1024, Math.floor(agent.maxMemorySize));
  if (typeof agent.consolidationTimeout === "number") next.agent.consolidationTimeout = Math.max(1000, Math.floor(agent.consolidationTimeout));
  if (typeof agent.subagentTimeout === "number") next.agent.subagentTimeout = Math.max(1000, Math.floor(agent.subagentTimeout));

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
  if (config.channels.telegram.enabled && !config.channels.telegram.token) errs.push("Telegram 启用时必须设置 token");
  if (config.channels.dingtalk.enabled) {
    if (!config.channels.dingtalk.clientId) errs.push("DingTalk 启用时必须设置 clientId");
    if (!config.channels.dingtalk.clientSecret) errs.push("DingTalk 启用时必须设置 clientSecret");
    if (!config.channels.dingtalk.robotCode) errs.push("DingTalk 启用时必须设置 robotCode");
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

export async function handleWebCommand(opts: WebOptions): Promise<void> {
  const host = opts.host || "127.0.0.1";
  const port = opts.port || 3180;
  const accessToken = opts.token || process.env.NEOCLAW_WEB_TOKEN || randomBytes(18).toString("base64url");
  const csrfToken = randomBytes(18).toString("base64url");

  mkdirSync(opts.baseDir, { recursive: true });

  const authLimiter = createRateLimiter(30, 60_000);
  const apiLimiter = createRateLimiter(300, 60_000);

  const server = createServer(async (req, res) => {
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
        // Send the React app index.html
        const indexHtmlPath = join(process.cwd(), "dist", "web", "index.html");
        try {
          const indexHtml = readFileSync(indexHtmlPath, "utf-8");
          // Optionally replace a placeholder with csrf context, but modern way is to serve static and have an API endpoint grab context.
          sendHtml(res, indexHtml.replace('__CSRF_TOKEN__', csrfToken));
        } catch (err) {
          sendHtml(res, "Web UI not built. Please run `npm run build` or use Vite dev server.");
        }
        return;
      }

      // Serve static assets for the React App
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/") && method === "GET") {
        let safePath = url.pathname.replace(/^(\.\.[\/\\])+/, '');
        if (safePath.startsWith('/')) safePath = safePath.slice(1);
        const resolvedPath = join(process.cwd(), "dist", "web", safePath);
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
            name: "自定义 / 其他兼容 API",
            authType: "custom",
            source: "custom",
            api: "openai",
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
              sendJson(res, 200, { models: [{ label: cp.name || cp.id, value: cp.id }] });
            } else {
              const pid = body.providerId as string;
              const bus = await getHeadlessBus(opts.baseDir);
              const mRes = await bus.request("models.list", { cwd: opts.baseDir });
              if (!mRes.success) throw new Error(mRes.error || "models.list failed");
              const group = (mRes.data?.groupedModels || []).find((g: any) => g.provider === pid || g.providerId === pid);
              const result = group?.models || [];
              sendJson(res, 200, { models: result.map((x: any) => ({ label: x.name || x.id, value: x.value || x.id })) });
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
          sendJson(res, 200, {
            ok: true,
            warning: "配置已写入。若正在运行 neoclaw 主进程，watcher 将自动热更新。",
            config: maskConfig(loadConfig(opts.baseDir)),
          });
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
    const close = () => {
      server.close(() => resolve());
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  });
}
