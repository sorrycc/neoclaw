import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";

export class MemoryManager {
  private memoryDir: string;

  constructor(workspace: string) {
    this.memoryDir = join(workspace, "memory");
    console.log("[MemoryManager] constructor: memoryDir =", this.memoryDir);
    mkdirSync(this.memoryDir, { recursive: true });
  }

  private get memoryPath(): string {
    return join(this.memoryDir, "MEMORY.md");
  }

  private get historyPath(): string {
    return join(this.memoryDir, "HISTORY.md");
  }

  readMemory(): string {
    console.log("[MemoryManager] readMemory");
    if (!existsSync(this.memoryPath)) return "";
    return readFileSync(this.memoryPath, "utf-8").trim();
  }

  writeMemory(content: string): void {
    console.log("[MemoryManager] writeMemory");
    writeFileSync(this.memoryPath, content, "utf-8");
  }

  appendHistory(entry: string): void {
    console.log("[MemoryManager] appendHistory");
    const line = `\n## ${new Date().toISOString()}\n${entry}\n`;
    appendFileSync(this.historyPath, line, "utf-8");
  }

  appendHistoryRotated(entry: string): void {
    console.log("[MemoryManager] appendHistoryRotated");
    const now = new Date();
    const line = `\n## ${now.toISOString()}\n${entry}\n`;

    // Write to main HISTORY.md (backward compat)
    appendFileSync(this.historyPath, line, "utf-8");

    // Write to monthly rotated file
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const rotatedPath = join(this.memoryDir, `HISTORY-${month}.md`);
    appendFileSync(rotatedPath, line, "utf-8");
  }
}
