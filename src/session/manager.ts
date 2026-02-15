import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";

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
}

export class SessionManager {
  private cache = new Map<string, Session>();
  private sessionsDir: string;

  constructor(workspace: string) {
    this.sessionsDir = join(workspace, "..", "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.sessionsDir, `${safe}.jsonl`);
  }

  get(key: string): Session {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const path = this.filePath(key);
    const session: Session = { key, messages: [], lastConsolidated: 0 };

    if (existsSync(path)) {
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj._type === "metadata") {
          session.lastConsolidated = obj.lastConsolidated ?? 0;
        } else {
          session.messages.push(obj as SessionEntry);
        }
      }
    }

    this.cache.set(key, session);
    return session;
  }

  append(key: string, role: string, content: string): void {
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
    const path = this.filePath(key);
    const meta: SessionMeta = { _type: "metadata", key, createdAt: new Date().toISOString(), lastConsolidated: 0 };
    writeFileSync(path, JSON.stringify(meta) + "\n", "utf-8");
    this.cache.set(key, { key, messages: [], lastConsolidated: 0 });
  }

  updateConsolidated(key: string, index: number): void {
    const session = this.get(key);
    session.lastConsolidated = index;
  }

  messageCount(key: string): number {
    return this.get(key).messages.length;
  }
}
