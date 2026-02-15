import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";

export class ContextBuilder {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  getSkillPaths(): string[] {
    const paths: string[] = [];
    const bootstrapFiles = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md"];

    for (const f of bootstrapFiles) {
      const p = join(this.workspace, f);
      if (existsSync(p)) paths.push(p);
    }

    const memoryPath = join(this.workspace, "memory", "MEMORY.md");
    if (existsSync(memoryPath)) paths.push(memoryPath);

    const skillsDir = join(this.workspace, "skills");
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, name, "SKILL.md");
        if (existsSync(skillFile)) paths.push(skillFile);
      }
    }

    return paths;
  }

  getSystemContext(): string {
    const parts: string[] = [];
    parts.push(`Current time: ${new Date().toISOString()}`);
    parts.push(`Workspace: ${this.workspace}`);

    const memoryPath = join(this.workspace, "memory", "MEMORY.md");
    if (existsSync(memoryPath)) {
      const memory = readFileSync(memoryPath, "utf-8").trim();
      if (memory) parts.push(`\n<memory>\n${memory}\n</memory>`);
    }

    return parts.join("\n");
  }
}
