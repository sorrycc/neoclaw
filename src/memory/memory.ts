import { join } from "path";
import { readFile, writeFile, appendFile, mkdir, access } from "fs/promises";
import { logger } from "../logger.js";

export class MemoryManager {
  private memoryDir: string;

  private constructor(workspace: string) {
    this.memoryDir = join(workspace, "memory");
  }

  static async create(workspace: string): Promise<MemoryManager> {
    const mgr = new MemoryManager(workspace);
    logger.debug("memory", "create: memoryDir =", mgr.memoryDir);
    await mkdir(mgr.memoryDir, { recursive: true });
    return mgr;
  }

  private get memoryPath(): string {
    return join(this.memoryDir, "MEMORY.md");
  }

  private get historyPath(): string {
    return join(this.memoryDir, "HISTORY.md");
  }

  async readMemory(): Promise<string> {
    try {
      await access(this.memoryPath);
      return (await readFile(this.memoryPath, "utf-8")).trim();
    } catch {
      return "";
    }
  }

  async writeMemory(content: string): Promise<void> {
    await writeFile(this.memoryPath, content, "utf-8");
  }

  async appendHistory(entry: string): Promise<void> {
    const line = `\n## ${new Date().toISOString()}\n${entry}\n`;
    await appendFile(this.historyPath, line, "utf-8");
  }

  async appendHistoryRotated(entry: string): Promise<void> {
    const now = new Date();
    const line = `\n## ${now.toISOString()}\n${entry}\n`;

    // Write to main HISTORY.md (backward compat)
    await appendFile(this.historyPath, line, "utf-8");

    // Write to monthly rotated file
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const rotatedPath = join(this.memoryDir, `HISTORY-${month}.md`);
    await appendFile(rotatedPath, line, "utf-8");
  }
}
