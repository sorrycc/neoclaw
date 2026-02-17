import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { prompt } from "@neovate/code";

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

  async consolidate(
    messages: Array<{ role: string; content: string }>,
    model: string
  ): Promise<void> {
    console.log("[MemoryManager] consolidate: messages =", messages.length);
    const currentMemory = this.readMemory();
    const conversationText = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    const consolidationPrompt = [
      "You are a memory consolidation assistant.",
      "Given the following conversation and current memory, produce a JSON response with two fields:",
      '- "history_entry": a brief summary of what happened (1-2 sentences)',
      '- "memory_update": updated long-term memory incorporating new facts from the conversation',
      "",
      "Current memory:",
      currentMemory || "(empty)",
      "",
      "Conversation:",
      conversationText,
      "",
      "Respond ONLY with valid JSON.",
    ].join("\n");

    try {
      const result = await prompt(consolidationPrompt, { model });
      const parsed = JSON.parse(result.content);
      if (parsed.memory_update) this.writeMemory(parsed.memory_update);
      if (parsed.history_entry) this.appendHistory(parsed.history_entry);
    } catch (err) {
      console.error("[memory] consolidation failed:", err);
    }
  }
}
