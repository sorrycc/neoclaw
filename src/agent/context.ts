import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";

const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"];

export class ContextBuilder {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
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
    parts.push(`Current time: ${new Date().toISOString()}`);
    parts.push(`Workspace: ${this.workspace}`);

    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) parts.push(bootstrap);

    const memoryPath = join(this.workspace, "memory", "MEMORY.md");
    if (existsSync(memoryPath)) {
      const memory = readFileSync(memoryPath, "utf-8").trim();
      if (memory) parts.push(`\n<memory>\n${memory}\n</memory>`);
    }

    if (channel && chatId) {
      parts.push(`\n## Current Session\nChannel: ${channel}\nChat ID: ${chatId}`);
    }

    return parts.join("\n");
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
