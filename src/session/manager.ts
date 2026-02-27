import { join } from "path";
import { readFile, writeFile, appendFile, mkdir, access } from "fs/promises";
import { logger } from "../logger.js";

interface SessionEntry {
  role: string;
  content: string;
  timestamp: string;
  toolsUsed?: string[];
}

interface SessionMeta {
  _type: "metadata";
  key: string;
  createdAt: string;
  lastConsolidated: number;
}

export interface Session {
  key: string;
  messages: SessionEntry[];
  lastConsolidated: number;
  createdAt: string;
}

export class SessionManager {
  private cache = new Map<string, Session>();

  private constructor(private sessionsDir: string) {}

  static async create(sessionsDir: string): Promise<SessionManager> {
    logger.debug("session", "create: sessionsDir =", sessionsDir);
    await mkdir(sessionsDir, { recursive: true });
    return new SessionManager(sessionsDir);
  }

  private filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.sessionsDir, `${safe}.jsonl`);
  }

  async get(key: string): Promise<Session> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const path = this.filePath(key);
    const session: Session = { key, messages: [], lastConsolidated: 0, createdAt: new Date().toISOString() };

    try {
      await access(path);
      const data = await readFile(path, "utf-8");
      const lines = data.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj._type === "metadata") {
            session.lastConsolidated = obj.lastConsolidated ?? 0;
            if (obj.createdAt) session.createdAt = obj.createdAt;
          } else {
            session.messages.push(obj as SessionEntry);
          }
        } catch (e) {
          logger.error("session", `corrupt line in session file, key=${key}`, e);
        }
      }
    } catch {
      // file doesn't exist yet
    }

    this.cache.set(key, session);
    return session;
  }

  async append(key: string, role: string, content: string): Promise<void> {
    logger.debug("session", "append:", key, role);
    const session = await this.get(key);
    const entry: SessionEntry = { role, content, timestamp: new Date().toISOString() };
    session.messages.push(entry);

    const path = this.filePath(key);
    try {
      await access(path);
    } catch {
      const meta: SessionMeta = { _type: "metadata", key, createdAt: new Date().toISOString(), lastConsolidated: 0 };
      await writeFile(path, JSON.stringify(meta) + "\n", "utf-8");
    }
    await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
  }

  async clear(key: string): Promise<void> {
    logger.debug("session", "clear:", key);
    const path = this.filePath(key);
    const meta: SessionMeta = { _type: "metadata", key, createdAt: new Date().toISOString(), lastConsolidated: 0 };
    await writeFile(path, JSON.stringify(meta) + "\n", "utf-8");
    this.cache.set(key, { key, messages: [], lastConsolidated: 0, createdAt: meta.createdAt });
  }

  async updateConsolidated(key: string, index: number): Promise<void> {
    logger.debug("session", "updateConsolidated:", key, index);
    const session = await this.get(key);
    session.lastConsolidated = index;
    await this.flush(key);
  }

  async trimBefore(key: string, keepFrom: number): Promise<void> {
    logger.debug("session", "trimBefore:", key, keepFrom);
    const session = await this.get(key);
    session.messages = session.messages.slice(keepFrom);
    session.lastConsolidated = 0;
    await this.flush(key);
  }

  private async flush(key: string): Promise<void> {
    const session = await this.get(key);
    const path = this.filePath(key);
    const meta: SessionMeta = {
      _type: "metadata", key, createdAt: session.createdAt,
      lastConsolidated: session.lastConsolidated,
    };
    const lines = [JSON.stringify(meta)];
    for (const msg of session.messages) {
      lines.push(JSON.stringify(msg));
    }
    await writeFile(path, lines.join("\n") + "\n", "utf-8");
  }

  async messageCount(key: string): Promise<number> {
    const session = await this.get(key);
    return session.messages.length;
  }
}
