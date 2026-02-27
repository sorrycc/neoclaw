export interface ConversationEntry {
  role: string;
  content: string;
  timestamp?: string;
  toolsUsed?: string[];
}

export interface ConsolidationResult {
  historyEntry?: string;
  memoryUpdate?: string;
}

export type PromptFn = (message: string, options: { model: string }) => Promise<{ content: string }>;
