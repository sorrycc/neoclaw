import { logger } from "../logger.js";
import type { ConversationEntry, MemoryFlushResult, PromptFn } from "./types.js";

export class MemoryFlushService {
  private promptFn: PromptFn;
  private model: string;

  constructor(promptFn: PromptFn, model: string) {
    this.promptFn = promptFn;
    this.model = model;
  }

  updateModel(model: string): void {
    this.model = model;
  }

  async flush(messages: ConversationEntry[], currentMemory: string): Promise<MemoryFlushResult> {
    if (!messages.length) return {};

    const conversationText = messages
      .filter((message) => message.content)
      .map((message) => {
        const ts = message.timestamp ? `[${message.timestamp.slice(0, 16)}]` : "[?]";
        const tools = message.toolsUsed?.length ? ` [tools: ${message.toolsUsed.join(", ")}]` : "";
        return `${ts} ${message.role.toUpperCase()}${tools}: ${message.content}`;
      })
      .join("\n");

    const flushPrompt = [
      "You are a memory flush agent.",
      "The conversation is about to be trimmed for context management.",
      "Return a JSON object with exactly two keys:",
      '1. "memory_note": concise durable facts or decisions that should be preserved in long-term memory now. Return an empty string if there is nothing clearly durable.',
      '2. "history_note": a short dated note only if a time-sensitive event, commitment, or decision should be appended to history before trim. Return an empty string otherwise.',
      "Only keep durable facts, preferences, constraints, commitments, or project decisions. Do not summarize transient chit-chat.",
      "Use markdown bullets only when it improves readability.",
      "",
      "## Current Long-term Memory",
      currentMemory || "(empty)",
      "",
      "## Conversation To Flush",
      conversationText,
      "",
      "Respond with ONLY valid JSON, no markdown fences.",
    ].join("\n");

    const result = await this.promptFn(flushPrompt, { model: this.model });
    const text = (result.content || "").trim();
    if (!text) return {};

    const parsed = this.parseResponse(text);
    logger.info("memory-flush", `done, hasMemoryNote=${!!parsed.memoryNote} hasHistoryNote=${!!parsed.historyNote} messages=${messages.length}`);
    return parsed;
  }

  private parseResponse(raw: string): MemoryFlushResult {
    let text = raw;

    if (text.startsWith("```")) {
      const lines = text.split("\n");
      lines.shift();
      if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```")) {
        lines.pop();
      }
      text = lines.join("\n").trim();
    }

    try {
      const parsed = JSON.parse(text);
      return this.extractFromParsed(parsed);
    } catch {
      // ignore
    }

    const start = text.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let index = start; index < text.length; index++) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          return this.extractFromParsed(parsed);
        } catch {
          // ignore
        }
      }
    }

    const result: MemoryFlushResult = {};
    const memoryMatch = text.match(/"memory_note"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const historyMatch = text.match(/"history_note"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (memoryMatch) {
      try { result.memoryNote = JSON.parse(`"${memoryMatch[1]}"`); } catch { /* ignore */ }
    }
    if (historyMatch) {
      try { result.historyNote = JSON.parse(`"${historyMatch[1]}"`); } catch { /* ignore */ }
    }
    return result;
  }

  private extractFromParsed(parsed: Record<string, string>): MemoryFlushResult {
    const result: MemoryFlushResult = {};
    if (parsed.memory_note) result.memoryNote = parsed.memory_note;
    if (parsed.history_note) result.historyNote = parsed.history_note;
    return result;
  }
}
