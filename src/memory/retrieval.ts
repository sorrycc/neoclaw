import { createHash } from "crypto";
import { basename, dirname, join } from "path";
import { access, mkdir, readFile, readdir, stat } from "fs/promises";
import type { MemorySearchConfig } from "../config/schema.js";
import { logger } from "../logger.js";
import type { MemoryRecord, MemorySearchHit } from "./types.js";

type SourceKind = "memory" | "history";

interface IndexedChunk {
  id: string;
  sourcePath: string;
  sourceKind: SourceKind;
  monthBucket: string | null;
  sectionKey: string | null;
  content: string;
  contentHash: string;
  createdAt: string | null;
  updatedAt: string;
  startLine: number;
  endLine: number;
}

interface SearchRow {
  id: string;
  sourcePath: string;
  sourceKind: SourceKind;
  content: string;
  createdAt: string | null;
  startLine: number | null;
  endLine: number | null;
  rank: number;
}

interface SqliteQuery<Result = unknown> {
  all(...args: unknown[]): Result[];
  get(...args: unknown[]): Result | null;
  run(...args: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  query<Result = unknown>(sql: string): SqliteQuery<Result>;
  close(): void;
}

const DEFAULT_CONFIG: Required<Omit<MemorySearchConfig, "indexPath" | "embeddings">> = {
  enabled: true,
  provider: "fts",
  maxResults: 5,
  minScore: 0,
  autoRecall: true,
  recencyHalfLifeDays: 30,
};

const TARGET_CHUNK_SIZE = 800;
const SOFT_MAX_CHUNK_SIZE = 1200;
const MAX_RECALL_CHARS = 2600;
const AUTO_RECALL_PATTERNS = [
  /\b(remember|recall|previous|prior|earlier|before|history|historical|last time|we discussed|we decided|preference|prefer|deadline|due date|decision|task|todo|branch|workspace|project|when did|what did|which)\b/i,
  /(之前|上次|以前|记得|还记得|我们说过|我们决定|偏好|习惯|历史|什么时候|任务|待办|分支|项目|工作区)/,
];

export class MemoryRetrievalService {
  private workspace: string;
  private memoryDir: string;
  private dbPath: string;
  private db?: SqliteDatabase;
  private dbReady: Promise<void> | null = null;
  private config: Required<Omit<MemorySearchConfig, "indexPath" | "embeddings">> & Pick<MemorySearchConfig, "indexPath" | "embeddings">;

  private constructor(workspace: string, config?: MemorySearchConfig) {
    this.workspace = workspace;
    this.memoryDir = join(workspace, "memory");
    this.config = this.normalizeConfig(config);
    this.dbPath = this.resolveIndexPath(this.config.indexPath);
  }

  static async create(workspace: string, config?: MemorySearchConfig): Promise<MemoryRetrievalService> {
    const service = new MemoryRetrievalService(workspace, config);
    await service.ensureDbReady();
    await service.sync();
    return service;
  }

  updateConfig(config?: MemorySearchConfig): void {
    const next = this.normalizeConfig(config);
    const nextDbPath = this.resolveIndexPath(next.indexPath);
    const shouldReopen = nextDbPath !== this.dbPath;
    this.config = next;
    if (shouldReopen) {
      this.dbPath = nextDbPath;
      this.db?.close();
      this.db = undefined;
      this.dbReady = null;
      void this.ensureDbReady().then(() => this.sync()).catch((error) => {
        logger.warn("memory-search", "failed to reopen memory index:", error);
      });
    }
  }

  shouldAutoRecall(query: string): boolean {
    if (!this.config.enabled || !this.config.autoRecall) return false;
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 8) return false;
    return AUTO_RECALL_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  async buildRecallSection(query: string): Promise<string | undefined> {
    if (!this.shouldAutoRecall(query)) return undefined;

    const hits = await this.search(query, { limit: this.config.maxResults });
    if (!hits.length) return undefined;

    const lines: string[] = [
      "## Relevant Memory Recall",
      "Use these retrieved notes only if they help answer the user accurately.",
    ];

    let usedChars = lines.join("\n").length;
    for (const hit of hits) {
      const lineHint = hit.startLine ? `:${hit.startLine}` : "";
      const line = `- [${hit.sourceKind}] ${hit.path}${lineHint} — ${hit.snippet}`;
      if (usedChars + line.length > MAX_RECALL_CHARS) break;
      lines.push(line);
      usedChars += line.length;
    }

    return lines.length > 2 ? lines.join("\n") : undefined;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const trimmed = id.trim();
    if (!trimmed) return undefined;

    await this.ensureDbReady();
    if (this.db) {
      await this.syncIfStale();
      const row = this.db.query<{
        id: string;
        sourcePath: string;
        sourceKind: SourceKind;
        content: string;
        createdAt: string | null;
        startLine: number | null;
        endLine: number | null;
      }>(`
        SELECT
          id as id,
          source_path as sourcePath,
          source_kind as sourceKind,
          content as content,
          created_at as createdAt,
          start_line as startLine,
          end_line as endLine
        FROM memory_chunks
        WHERE id = ?
        LIMIT 1
      `).get(trimmed);
      if (row) {
        return {
          id: row.id,
          path: row.sourcePath,
          sourceKind: row.sourceKind,
          content: row.content,
          startLine: row.startLine ?? undefined,
          endLine: row.endLine ?? undefined,
          createdAt: row.createdAt ?? undefined,
        };
      }
    }

    const fallback = await this.fallbackFindById(trimmed);
    return fallback;
  }

  async search(query: string, opts?: { limit?: number }): Promise<MemorySearchHit[]> {
    if (!this.config.enabled) return [];
    await this.ensureDbReady();
    if (this.db) {
      await this.syncIfStale();
    }

    const trimmed = query.trim();
    if (!trimmed) return [];

    if (this.db) {
      try {
        const rows = this.searchFts(trimmed, opts?.limit ?? this.config.maxResults);
        if (rows.length) {
          return rows
            .map((row) => this.toHit(row))
            .filter((hit) => hit.score >= this.config.minScore)
            .slice(0, opts?.limit ?? this.config.maxResults);
        }
      } catch (error) {
        logger.warn("memory-search", "fts search failed, falling back to direct scan:", error);
      }
    }

    return this.fallbackSearch(trimmed, opts?.limit ?? this.config.maxResults);
  }

  async sync(): Promise<void> {
    if (!this.config.enabled) return;
    await this.ensureDbReady();
    if (!this.db) return;

    const files = await this.listCanonicalFiles();
    const chunksByPath = new Map<string, IndexedChunk[]>();
    const now = new Date().toISOString();

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const fileChunks = this.chunkFile(filePath, content, now);
        chunksByPath.set(filePath, fileChunks);
        const fileStat = await stat(filePath);
        this.setMeta(`mtime:${filePath}`, String(fileStat.mtimeMs));
        this.setMeta(`size:${filePath}`, String(fileStat.size));
      } catch (error) {
        logger.warn("memory-search", `failed to index ${filePath}:`, error);
      }
    }

    const existingPaths = this.db.query<{ sourcePath: string }>("SELECT DISTINCT source_path as sourcePath FROM memory_chunks").all();
    const activePathSet = new Set(files);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { sourcePath } of existingPaths) {
        if (!activePathSet.has(sourcePath)) {
          this.deleteChunksForPath(sourcePath);
          this.deleteMeta(`mtime:${sourcePath}`);
          this.deleteMeta(`size:${sourcePath}`);
        }
      }

      for (const [sourcePath, chunks] of chunksByPath) {
        this.deleteChunksForPath(sourcePath);
        for (const chunk of chunks) {
          this.insertChunk(chunk);
        }
      }

      this.setMeta("last_sync_at", now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async ensureDbReady(): Promise<void> {
    if (this.dbReady) {
      await this.dbReady;
      return;
    }

    this.dbReady = this.openDb();
    await this.dbReady;
  }

  private async openDb(): Promise<void> {
    if (typeof Bun === "undefined") {
      logger.warn("memory-search", "SQLite FTS is unavailable in this runtime, using direct file scan fallback");
      return;
    }

    try {
      await mkdir(dirname(this.dbPath), { recursive: true });
      const sqlite = await import("bun:sqlite");
      const DatabaseCtor = sqlite.Database as unknown as new (filename: string, options?: { create?: boolean }) => SqliteDatabase;
      this.db = new DatabaseCtor(this.dbPath, { create: true });
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.initSchema();
    } catch (error) {
      this.db = undefined;
      logger.warn("memory-search", "failed to initialize SQLite index, using direct file scan fallback:", error);
    }
  }

  private normalizeConfig(config?: MemorySearchConfig): Required<Omit<MemorySearchConfig, "indexPath" | "embeddings">> & Pick<MemorySearchConfig, "indexPath" | "embeddings"> {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      embeddings: {
        enabled: config?.embeddings?.enabled ?? false,
        model: config?.embeddings?.model,
        dims: config?.embeddings?.dims,
      },
    };
  }

  private resolveIndexPath(indexPath?: string): string {
    return indexPath?.trim() || join(this.workspace, "..", "state", "memory", "index.sqlite");
  }

  private initSchema(): void {
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        month_bucket TEXT,
        section_key TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        content,
        source_path UNINDEXED,
        source_kind UNINDEXED,
        content='memory_chunks',
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS memory_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private async syncIfStale(): Promise<void> {
    if (!this.db) return;
    const files = await this.listCanonicalFiles();
    for (const filePath of files) {
      try {
        const fileStat = await stat(filePath);
        const savedMtime = this.getMeta(`mtime:${filePath}`);
        const savedSize = this.getMeta(`size:${filePath}`);
        if (savedMtime !== String(fileStat.mtimeMs) || savedSize !== String(fileStat.size)) {
          await this.sync();
          return;
        }
      } catch {
        await this.sync();
        return;
      }
    }
  }

  private searchFts(query: string, limit: number): SearchRow[] {
    if (!this.db) return [];

    const sql = `
      SELECT
        c.id as id,
        c.source_path as sourcePath,
        c.source_kind as sourceKind,
        c.content as content,
        c.created_at as createdAt,
        c.start_line as startLine,
        c.end_line as endLine,
        bm25(memory_chunks_fts, 1.0, 0.25) as rank
      FROM memory_chunks_fts
      JOIN memory_chunks c ON c.rowid = memory_chunks_fts.rowid
      WHERE memory_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;

    const strictRows = this.db.query<SearchRow>(sql).all(this.toFtsQuery(query, false), limit * 3);
    if (strictRows.length > 0) return strictRows;
    return this.db.query<SearchRow>(sql).all(this.toFtsQuery(query, true), limit * 3);
  }

  private async fallbackFindById(id: string): Promise<MemoryRecord | undefined> {
    const files = await this.listCanonicalFiles();
    const now = new Date().toISOString();

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const chunks = this.chunkFile(filePath, content, now);
        const match = chunks.find((chunk) => chunk.id === id);
        if (match) {
          return {
            id: match.id,
            path: match.sourcePath,
            sourceKind: match.sourceKind,
            content: match.content,
            startLine: match.startLine,
            endLine: match.endLine,
            createdAt: match.createdAt ?? undefined,
          };
        }
      } catch {
      }
    }

    return undefined;
  }

  private async fallbackSearch(query: string, limit: number): Promise<MemorySearchHit[]> {
    const files = await this.listCanonicalFiles();
    const now = new Date().toISOString();
    const chunks: IndexedChunk[] = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        chunks.push(...this.chunkFile(filePath, content, now));
      } catch {
      }
    }

    const tokens = this.tokenize(query);
    return chunks
      .map((chunk) => {
        const lowered = chunk.content.toLowerCase();
        const matches = tokens.reduce((sum, token) => sum + (lowered.includes(token) ? 1 : 0), 0);
        const score = matches / Math.max(tokens.length, 1) + this.sourceBoost(chunk.sourceKind) + this.recencyBoost(chunk.createdAt);
        return { chunk, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        id: chunk.id,
        path: chunk.sourcePath,
        sourceKind: chunk.sourceKind,
        score,
        snippet: this.createSnippet(chunk.content),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        createdAt: chunk.createdAt ?? undefined,
      }));
  }

  private toHit(row: SearchRow): MemorySearchHit {
    const lexicalScore = 1 / (1 + Math.abs(row.rank ?? 0));
    const score = lexicalScore + this.sourceBoost(row.sourceKind) + this.recencyBoost(row.createdAt);
    return {
      id: row.id,
      path: row.sourcePath,
      sourceKind: row.sourceKind,
      score,
      snippet: this.createSnippet(row.content),
      startLine: row.startLine ?? undefined,
      endLine: row.endLine ?? undefined,
      createdAt: row.createdAt ?? undefined,
    };
  }

  private sourceBoost(sourceKind: SourceKind): number {
    return sourceKind === "memory" ? 0.2 : 0;
  }

  private recencyBoost(createdAt?: string | null): number {
    if (!createdAt) return 0;
    const halfLifeDays = Math.max(1, this.config.recencyHalfLifeDays);
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= 0) return 0.15;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return 0.15 * Math.exp((-Math.log(2) * ageDays) / halfLifeDays);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .slice(0, 8);
  }

  private toFtsQuery(text: string, relaxed: boolean): string {
    const tokens = this.tokenize(text);
    if (!tokens.length) return '""';
    if (relaxed) return tokens.map((token) => `${this.escapeFtsToken(token)}*`).join(" OR ");
    return tokens.map((token) => `${this.escapeFtsToken(token)}*`).join(" ");
  }

  private escapeFtsToken(token: string): string {
    return token.replace(/[\"]+/g, "").replace(/[^\p{L}\p{N}_-]+/gu, "");
  }

  private createSnippet(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim();
    return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
  }

  private async listCanonicalFiles(): Promise<string[]> {
    const files: string[] = [];
    const memoryPath = join(this.memoryDir, "MEMORY.md");
    if (await this.pathExists(memoryPath)) files.push(memoryPath);

    const historyPath = join(this.memoryDir, "HISTORY.md");
    if (await this.pathExists(historyPath)) files.push(historyPath);

    try {
      const names = await readdir(this.memoryDir);
      for (const name of names.sort()) {
        if (/^HISTORY-\d{4}-\d{2}\.md$/.test(name)) {
          files.push(join(this.memoryDir, name));
        }
      }
    } catch {
      return files;
    }

    return files;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private chunkFile(sourcePath: string, content: string, updatedAt: string): IndexedChunk[] {
    if (basename(sourcePath) === "MEMORY.md") {
      return this.chunkMemoryFile(sourcePath, content, updatedAt);
    }
    return this.chunkHistoryFile(sourcePath, content, updatedAt);
  }

  private chunkMemoryFile(sourcePath: string, content: string, updatedAt: string): IndexedChunk[] {
    const lines = content.split(/\r?\n/);
    const sections: Array<{ headingPath: string[]; startLine: number; lines: string[] }> = [];
    const headingPath: string[] = [];
    let currentStart = 1;
    let currentLines: string[] = [];

    const pushSection = () => {
      const text = currentLines.join("\n").trim();
      if (!text) return;
      sections.push({ headingPath: [...headingPath], startLine: currentStart, lines: [...currentLines] });
    };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        pushSection();
        const level = headingMatch[1].length;
        headingPath.splice(level - 1);
        headingPath[level - 1] = headingMatch[2].trim();
        currentLines = [line];
        currentStart = index + 1;
      } else {
        currentLines.push(line);
      }
    }
    pushSection();

    if (!sections.length && content.trim()) {
      sections.push({ headingPath: [], startLine: 1, lines });
    }

    const chunks: IndexedChunk[] = [];
    for (const section of sections) {
      const sectionKey = section.headingPath.length ? section.headingPath.join(" > ") : null;
      chunks.push(...this.chunkParagraphGroups({
        sourcePath,
        sourceKind: "memory",
        monthBucket: null,
        sectionKey,
        createdAt: null,
        updatedAt,
        lines: section.lines,
        baseLine: section.startLine,
      }));
    }
    return chunks;
  }

  private chunkHistoryFile(sourcePath: string, content: string, updatedAt: string): IndexedChunk[] {
    const lines = content.split(/\r?\n/);
    const entries: Array<{ timestamp: string; startLine: number; lines: string[] }> = [];
    let currentTimestamp = "";
    let currentStart = 1;
    let currentLines: string[] = [];

    const pushEntry = () => {
      if (!currentTimestamp || !currentLines.length) return;
      entries.push({ timestamp: currentTimestamp, startLine: currentStart, lines: [...currentLines] });
    };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const match = line.match(/^##\s+(.+)$/);
      if (match) {
        pushEntry();
        currentTimestamp = match[1].trim();
        currentStart = index + 1;
        currentLines = [line];
      } else if (currentTimestamp) {
        currentLines.push(line);
      }
    }
    pushEntry();

    const monthBucket = this.extractMonthBucket(sourcePath);
    const chunks: IndexedChunk[] = [];
    for (const entry of entries) {
      chunks.push(...this.chunkParagraphGroups({
        sourcePath,
        sourceKind: "history",
        monthBucket: monthBucket || entry.timestamp.slice(0, 7),
        sectionKey: entry.timestamp,
        createdAt: entry.timestamp,
        updatedAt,
        lines: entry.lines,
        baseLine: entry.startLine,
      }));
    }
    return chunks;
  }

  private extractMonthBucket(sourcePath: string): string | null {
    const match = basename(sourcePath).match(/^HISTORY-(\d{4}-\d{2})\.md$/);
    return match?.[1] ?? null;
  }

  private chunkParagraphGroups(params: {
    sourcePath: string;
    sourceKind: SourceKind;
    monthBucket: string | null;
    sectionKey: string | null;
    createdAt: string | null;
    updatedAt: string;
    lines: string[];
    baseLine: number;
  }): IndexedChunk[] {
    const paragraphs = this.extractParagraphs(params.lines, params.baseLine);
    if (!paragraphs.length) {
      return [];
    }

    const chunks: IndexedChunk[] = [];
    let startIndex = 0;
    while (startIndex < paragraphs.length) {
      let endIndex = startIndex;
      let currentLength = 0;
      let currentText = "";
      while (endIndex < paragraphs.length) {
        const next = paragraphs[endIndex]!;
        const nextText = currentText ? `${currentText}\n\n${next.text}` : next.text;
        if (nextText.length > SOFT_MAX_CHUNK_SIZE && currentLength >= TARGET_CHUNK_SIZE) {
          break;
        }
        currentText = nextText;
        currentLength = currentText.length;
        endIndex += 1;
      }

      const slice = paragraphs.slice(startIndex, endIndex);
      const content = currentText.trim();
      if (content) {
        const startLine = slice[0]!.startLine;
        const endLine = slice[slice.length - 1]!.endLine;
        chunks.push({
          id: this.hash(`${params.sourcePath}:${startLine}:${endLine}:${content}`),
          sourcePath: params.sourcePath,
          sourceKind: params.sourceKind,
          monthBucket: params.monthBucket,
          sectionKey: params.sectionKey,
          content,
          contentHash: this.hash(content),
          createdAt: params.createdAt,
          updatedAt: params.updatedAt,
          startLine,
          endLine,
        });
      }
      startIndex = endIndex;
    }

    return chunks;
  }

  private extractParagraphs(lines: string[], baseLine: number): Array<{ text: string; startLine: number; endLine: number }> {
    const paragraphs: Array<{ text: string; startLine: number; endLine: number }> = [];
    let current: string[] = [];
    let startLine = baseLine;

    const pushCurrent = (lineNumber: number) => {
      const text = current.join("\n").trim();
      if (text) {
        paragraphs.push({ text, startLine, endLine: lineNumber - 1 });
      }
      current = [];
    };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const lineNumber = baseLine + index;
      if (!current.length) startLine = lineNumber;
      if (!line.trim()) {
        pushCurrent(lineNumber);
        continue;
      }
      current.push(line);
    }

    if (current.length) {
      paragraphs.push({ text: current.join("\n").trim(), startLine, endLine: baseLine + lines.length - 1 });
    }

    return paragraphs;
  }

  private deleteChunksForPath(sourcePath: string): void {
    this.db?.query("DELETE FROM memory_chunks WHERE source_path = ?").run(sourcePath);
  }

  private insertChunk(chunk: IndexedChunk): void {
    this.db?.query(`
      INSERT INTO memory_chunks (
        id, source_path, source_kind, month_bucket, section_key, content,
        content_hash, created_at, updated_at, start_line, end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chunk.id,
      chunk.sourcePath,
      chunk.sourceKind,
      chunk.monthBucket,
      chunk.sectionKey,
      chunk.content,
      chunk.contentHash,
      chunk.createdAt,
      chunk.updatedAt,
      chunk.startLine,
      chunk.endLine,
    );
  }

  private getMeta(key: string): string | null {
    const row = this.db?.query<{ value: string }>("SELECT value FROM memory_index_meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db?.query(`
      INSERT INTO memory_index_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private deleteMeta(key: string): void {
    this.db?.query("DELETE FROM memory_index_meta WHERE key = ?").run(key);
  }

  private hash(text: string): string {
    return createHash("sha1").update(text).digest("hex");
  }
}
