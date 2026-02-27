import type { ConversationEntry, ConsolidationResult, PromptFn } from "./types.js";

export class ConsolidationService {
  private promptFn: PromptFn;
  private model: string;
  private maxMemorySize: number;

  private queue: Array<{
    messages: ConversationEntry[];
    currentMemory: string;
    resolve: (result: ConsolidationResult) => void;
    reject: (err: unknown) => void;
  }> = [];
  private draining = false;

  constructor(promptFn: PromptFn, model: string, maxMemorySize = 8192) {
    this.promptFn = promptFn;
    this.model = model;
    this.maxMemorySize = maxMemorySize;
  }

  updateModel(model: string): void {
    this.model = model;
  }

  updateMaxMemorySize(maxMemorySize: number): void {
    this.maxMemorySize = maxMemorySize;
  }

  consolidate(messages: ConversationEntry[], currentMemory: string): Promise<ConsolidationResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ messages, currentMemory, resolve, reject });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          const result = await this.doConsolidate(item.messages, item.currentMemory);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async doConsolidate(messages: ConversationEntry[], currentMemory: string): Promise<ConsolidationResult> {
    if (!messages.length) return {};

    const conversationText = messages
      .filter((m) => m.content)
      .map((m) => {
        const ts = m.timestamp ? `[${m.timestamp.slice(0, 16)}]` : "[?]";
        const tools = m.toolsUsed?.length ? ` [tools: ${m.toolsUsed.join(", ")}]` : "";
        return `${ts} ${m.role.toUpperCase()}${tools}: ${m.content}`;
      })
      .join("\n");

    const compressionNote =
      currentMemory.length > this.maxMemorySize
        ? "\n\nIMPORTANT: The current memory exceeds the size limit. In your memory_update, compress and prune stale or low-value facts to keep it concise. Prioritize recent and frequently-referenced information."
        : "";

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
      compressionNote,
      "",
      "Respond with ONLY valid JSON, no markdown fences.",
    ].join("\n");

    const result = await this.promptFn(consolidationPrompt, { model: this.model });
    const text = (result.content || "").trim();
    if (!text) return {};

    return this.parseResponse(text);
  }

  private parseResponse(raw: string): ConsolidationResult {
    let text = raw;

    // Strip markdown fences
    if (text.startsWith("```")) {
      const lines = text.split("\n");
      lines.shift(); // remove opening fence line
      if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```")) {
        lines.pop();
      }
      text = lines.join("\n").trim();
    }

    // Tier 1: direct JSON.parse
    try {
      const parsed = JSON.parse(text);
      return this.extractFromParsed(parsed);
    } catch {
      // fall through
    }

    // Tier 2: extract first {...} block via brace matching
    const start = text.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          return this.extractFromParsed(parsed);
        } catch {
          // fall through
        }
      }
    }

    // Tier 3: regex extraction of individual fields
    const result: ConsolidationResult = {};
    const historyMatch = text.match(/"history_entry"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const memoryMatch = text.match(/"memory_update"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (historyMatch) {
      try { result.historyEntry = JSON.parse(`"${historyMatch[1]}"`); } catch { /* skip */ }
    }
    if (memoryMatch) {
      try { result.memoryUpdate = JSON.parse(`"${memoryMatch[1]}"`); } catch { /* skip */ }
    }
    return result;
  }

  private extractFromParsed(parsed: Record<string, string>): ConsolidationResult {
    const result: ConsolidationResult = {};
    if (parsed.history_entry) result.historyEntry = parsed.history_entry;
    if (parsed.memory_update) result.memoryUpdate = parsed.memory_update;
    return result;
  }
}
