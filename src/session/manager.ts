import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
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
  private sessionsDir: string;

  constructor(workspace: string) {
    this.sessionsDir = join(workspace, "..", "sessions");
    logger.debug("session", "constructor: sessionsDir =", this.sessionsDir);
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.sessionsDir, `${safe}.jsonl`);
  }

  get(key: string): Session {
    logger.debug("session", "get:", key);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const path = this.filePath(key);
    const session: Session = { key, messages: [], lastConsolidated: 0, createdAt: new Date().toISOString() };

    if (existsSync(path)) {
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj._type === "metadata") {
          session.lastConsolidated = obj.lastConsolidated ?? 0;
          if (obj.createdAt) session.createdAt = obj.createdAt;
        } else {
          session.messages.push(obj as SessionEntry);
        }
      }
    }

    this.cache.set(key, session);
    return session;
  }

  append(key: string, role: string, content: string): void {
    logger.debug("session", "append:", key, role);
    const session = this.get(key);
    const entry: SessionEntry = { role, content, timestamp: new Date().toISOString() };
    session.messages.push(entry);

    const path = this.filePath(key);
    if (!existsSync(path)) {
      const meta: SessionMeta = { _type: "metadata", key, createdAt: new Date().toISOString(), lastConsolidated: 0 };
      writeFileSync(path, JSON.stringify(meta) + "\n", "utf-8");
    }
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  }

  clear(key: string): void {
    logger.debug("session", "clear:", key);
    const path = this.filePath(key);
    const meta: SessionMeta = { _type: "metadata", key, createdAt: new Date().toISOString(), lastConsolidated: 0 };
    writeFileSync(path, JSON.stringify(meta) + "\n", "utf-8");
    this.cache.set(key, { key, messages: [], lastConsolidated: 0, createdAt: meta.createdAt });
  }

  updateConsolidated(key: string, index: number): void {
    logger.debug("session", "updateConsolidated:", key, index);
    const session = this.get(key);
    session.lastConsolidated = index;
    this.flush(key);
  }

  trimBefore(key: string, keepFrom: number): void {
    logger.debug("session", "trimBefore:", key, keepFrom);
    const session = this.get(key);
    session.messages = session.messages.slice(keepFrom);
    session.lastConsolidated = 0;
    this.flush(key);
  }

  private flush(key: string): void {
    const session = this.get(key);
    const path = this.filePath(key);
    const meta: SessionMeta = {
      _type: "metadata", key, createdAt: session.createdAt,
      lastConsolidated: session.lastConsolidated,
    };
    const lines = [JSON.stringify(meta)];
    for (const msg of session.messages) {
      lines.push(JSON.stringify(msg));
    }
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  }

  messageCount(key: string): number {
    const count = this.get(key).messages.length;
    logger.debug("session", "messageCount:", key, count);
    return count;
  }
}
