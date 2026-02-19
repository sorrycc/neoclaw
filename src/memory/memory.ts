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
    messages: Array<{ role: string; content: string; timestamp?: string; toolsUsed?: string[] }>,
    model: string
  ): Promise<void> {
    console.log("[MemoryManager] consolidate: messages =", messages.length);
    if (!messages.length) return;

    const currentMemory = this.readMemory();
    const conversationText = messages
      .filter((m) => m.content)
      .map((m) => {
        const ts = m.timestamp ? `[${m.timestamp.slice(0, 16)}]` : "[?]";
        const tools = m.toolsUsed?.length ? ` [tools: ${m.toolsUsed.join(", ")}]` : "";
        return `${ts} ${m.role.toUpperCase()}${tools}: ${m.content}`;
      })
      .join("\n");

    const consolidationPrompt = [
      "You are a memory consolidation agent. Process this conversation and return a JSON object with exactly two keys:",
      "",
      '1. "history_entry": A paragraph (2-5 sentences) summarizing the key events/decisions/topics. Start with a timestamp like [YYYY-MM-DD HH:MM]. Include enough detail to be useful when found by grep search later.',
      "",
      '2. "memory_update": The updated long-term memory content. Add any new facts: user location, preferences, personal info, habits, project context, technical decisions, tools/services used. If nothing new, return the existing content unchanged.',
      "",
      "## Current Long-term Memory",
      currentMemory || "(empty)",
      "",
      "## Conversation to Process",
      conversationText,
      "",
      "Respond with ONLY valid JSON, no markdown fences.",
    ].join("\n");

    try {
      const result = await prompt(consolidationPrompt, { model });
      let text = (result.content || "").trim();
      if (!text) return;

      if (text.startsWith("```")) {
        text = text.split("\n", 2).pop()!;
        text = text.replace(/```\s*$/, "").trim();
      }

      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(text);
      } catch {
        const historyMatch = text.match(/"history_entry"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const memoryMatch = text.match(/"memory_update"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!historyMatch && !memoryMatch) return;
        parsed = {};
        if (historyMatch) parsed.history_entry = JSON.parse(`"${historyMatch[1]}"`);
        if (memoryMatch) parsed.memory_update = JSON.parse(`"${memoryMatch[1]}"`);
      }

      if (parsed.history_entry) this.appendHistory(parsed.history_entry);
      if (parsed.memory_update && parsed.memory_update !== currentMemory) {
        this.writeMemory(parsed.memory_update);
      }
    } catch (err) {
      console.error("[memory] consolidation failed:", err);
    }
  }
}
