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

export interface MemoryFlushResult {
  memoryNote?: string;
  historyNote?: string;
}

export interface MemoryRecord {
  id: string;
  path: string;
  sourceKind: "memory" | "history";
  content: string;
  startLine?: number;
  endLine?: number;
  createdAt?: string;
}

export interface MemorySearchHit {
  id: string;
  path: string;
  sourceKind: "memory" | "history";
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  createdAt?: string;
}

export type PromptFn = (message: string, options: { model: string }) => Promise<{ content: string }>;
