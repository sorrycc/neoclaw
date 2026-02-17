import { join, resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { arch, type as osType } from "os";
import type { MemoryManager } from "../memory/memory.js";

const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"];

export class ContextBuilder {
  private workspace: string;
  private memory: MemoryManager;

  constructor(workspace: string, memory: MemoryManager) {
    this.workspace = workspace;
    this.memory = memory;
  }

  getSkillPaths(): string[] {
    const paths: string[] = [];
    const skillsDir = join(this.workspace, "skills");
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, name, "SKILL.md");
        if (existsSync(skillFile)) paths.push(skillFile);
      }
    }
    return paths;
  }

  getSystemContext(channel?: string, chatId?: string): string {
    const parts: string[] = [];

    parts.push(this.getIdentity());

    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) parts.push(bootstrap);

    const mem = this.memory.readMemory();
    if (mem) parts.push(`# Memory\n\n${mem}`);

    if (channel && chatId) {
      parts.push(`## Current Session\nChannel: ${channel}\nChat ID: ${chatId}`);
    }

    return parts.join("\n\n---\n\n");
  }

  private getIdentity(): string {
    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "long",
      hour12: false,
    });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ws = resolve(this.workspace);
    const system = osType();
    const os = system === "Darwin" ? "macOS" : system;
    const runtime = `${os} ${arch()}, Bun ${typeof Bun !== "undefined" ? Bun.version : process.version}`;

    return `# neoclaw

You are neoclaw, a helpful AI assistant. You have access to tools that allow you to:
- Read, write, and edit files
- Execute shell commands
- Search the web and fetch web pages
- Send messages to users on chat channels
- Spawn subagents for complex background tasks

## Current Time
${timeStr} (${tz})

## Runtime
${runtime}

## Workspace
Your workspace is at: ${ws}
- Long-term memory: ${ws}/memory/MEMORY.md
- History log: ${ws}/memory/HISTORY.md (grep-searchable)

IMPORTANT: When responding to direct questions or conversations, reply directly with your text response.
Only use the 'message' tool when you need to send a message to a specific chat channel.
For normal conversation, just respond with text - do not call the message tool.

Always be helpful, accurate, and concise. When using tools, think step by step: what you know, what you need, and why you chose this tool.
When remembering something important, write to ${ws}/memory/MEMORY.md
To recall past events, grep ${ws}/memory/HISTORY.md`;
  }

  private loadBootstrapFiles(): string {
    const parts: string[] = [];
    for (const filename of BOOTSTRAP_FILES) {
      const filePath = join(this.workspace, filename);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content) parts.push(`## ${filename}\n\n${content}`);
      }
    }
    return parts.join("\n\n");
  }
}
