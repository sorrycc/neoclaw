import { join } from "path";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { prompt } from "@neovate/code";

export class MemoryManager {
  private memoryDir: string;

  constructor(workspace: string) {
    this.memoryDir = join(workspace, "memory");
    mkdirSync(this.memoryDir, { recursive: true });
  }

  private get memoryPath(): string {
    return join(this.memoryDir, "MEMORY.md");
  }

  private get historyPath(): string {
    return join(this.memoryDir, "HISTORY.md");
  }

  readMemory(): string {
    if (!existsSync(this.memoryPath)) return "";
    return readFileSync(this.memoryPath, "utf-8").trim();
  }

  writeMemory(content: string): void {
    writeFileSync(this.memoryPath, content, "utf-8");
  }

  appendHistory(entry: string): void {
    const line = `\n## ${new Date().toISOString()}\n${entry}\n`;
    appendFileSync(this.historyPath, line, "utf-8");
  }

  async consolidate(
    messages: Array<{ role: string; content: string }>,
    model: string
  ): Promise<void> {
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
