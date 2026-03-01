import { join } from "path";
import { readdir, stat, readFile, access } from "fs/promises";
import matter from "gray-matter";

export interface SkillInfo {
  name: string;
  description: string;
}

export class SkillManager {
  constructor(private workspace: string) {}

  private get skillsDir(): string {
    return join(this.workspace, "skills");
  }

  async getSkills(): Promise<SkillInfo[]> {
    try {
      await access(this.skillsDir);
    } catch {
      return [];
    }
    const entries = await readdir(this.skillsDir);
    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      const skillPath = join(this.skillsDir, entry);
      const s = await stat(skillPath);
      if (!s.isDirectory()) continue;
      const skillFile = join(skillPath, "SKILL.md");
      try {
        await access(skillFile);
      } catch {
        continue;
      }
      const raw = await readFile(skillFile, "utf-8");
      const { data } = matter(raw);
      skills.push({
        name: data.name ?? entry,
        description: data.description ?? "",
      });
    }
    return skills;
  }

  async getSkillNames(): Promise<string[]> {
    return (await this.getSkills()).map((s) => s.name);
  }

  async getSkillPaths(): Promise<string[]> {
    try {
      await access(this.skillsDir);
    } catch {
      return [];
    }
    const paths: string[] = [];
    const entries = await readdir(this.skillsDir);
    for (const name of entries) {
      const skillFile = join(this.skillsDir, name, "SKILL.md");
      try {
        await access(skillFile);
        paths.push(skillFile);
      } catch {
        // no SKILL.md, skip
      }
    }
    return paths;
  }

  async resolveSkillCommand(content: string): Promise<string | null> {
    if (!content.startsWith("/")) return null;
    const spaceIdx = content.indexOf(" ");
    const command = spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();
    const skillDir = join(this.skillsDir, command);
    const skillFile = join(skillDir, "SKILL.md");
    try {
      await access(skillFile);
    } catch {
      return null;
    }
    const raw = await readFile(skillFile, "utf-8");
    const { content: body } = matter(raw);
    let p = `Base directory for this skill: ${skillDir}\n\n${body.trim()}`;
    const hasPositional = /\$[1-9]\d*/.test(p);
    if (hasPositional) {
      const parsed = args.split(" ");
      for (let i = 0; i < parsed.length; i++) {
        p = p.replace(new RegExp(`\\$${i + 1}\\b`, "g"), parsed[i] || "");
      }
    } else if (p.includes("$ARGUMENTS")) {
      p = p.replace(/\$ARGUMENTS/g, args || "");
    } else if (args) {
      p += `\n\nArguments: ${args}`;
    }
    return p;
  }
}
