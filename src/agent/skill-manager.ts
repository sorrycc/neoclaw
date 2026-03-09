import { join, relative } from "path";
import { readdir, stat, readFile, access, rm } from "fs/promises";
import matter from "gray-matter";

export interface SkillInfo {
  name: string;
  description: string;
}

export interface SkillDetail extends SkillInfo {
  dirName: string;
  path: string;
  relativePath: string;
  content: string;
  updatedAt: string;
}

export class SkillManager {
  constructor(private workspace: string) {}

  private get skillsDir(): string {
    return join(this.workspace, "skills");
  }

  private async readSkillDetail(dirName: string): Promise<SkillDetail | null> {
    const skillPath = join(this.skillsDir, dirName);
    const skillFile = join(skillPath, "SKILL.md");

    try {
      const skillStat = await stat(skillPath);
      if (!skillStat.isDirectory()) return null;
      await access(skillFile);
      const fileStat = await stat(skillFile);
      const raw = await readFile(skillFile, "utf-8");
      const { data, content } = matter(raw);
      return {
        dirName,
        name: String(data.name ?? dirName),
        description: String(data.description ?? ""),
        path: skillFile,
        relativePath: relative(this.workspace, skillFile),
        content: content.trim(),
        updatedAt: fileStat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async getSkills(): Promise<SkillInfo[]> {
    return (await this.getSkillDetails()).map(({ name, description }) => ({ name, description }));
  }

  async getSkillDetails(): Promise<SkillDetail[]> {
    try {
      await access(this.skillsDir);
    } catch {
      return [];
    }

    const entries = await readdir(this.skillsDir);
    const details: SkillDetail[] = [];
    for (const entry of entries) {
      const detail = await this.readSkillDetail(entry);
      if (detail) details.push(detail);
    }
    return details.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getSkillDetail(nameOrDir: string): Promise<SkillDetail | null> {
    const trimmed = nameOrDir.trim();
    if (!trimmed) return null;

    const byDir = await this.readSkillDetail(trimmed);
    if (byDir) return byDir;

    const details = await this.getSkillDetails();
    return details.find((detail) => detail.name === trimmed) ?? null;
  }

  async deleteSkill(nameOrDir: string): Promise<boolean> {
    const detail = await this.getSkillDetail(nameOrDir);
    if (!detail) return false;
    await rm(join(this.skillsDir, detail.dirName), { recursive: true, force: true });
    return true;
  }

  async hasSkill(nameOrDir: string): Promise<boolean> {
    return Boolean(await this.getSkillDetail(nameOrDir));
  }

  async getSkillNames(): Promise<string[]> {
    return (await this.getSkills()).map((s) => s.name);
  }

  async getSkillPaths(): Promise<string[]> {
    return (await this.getSkillDetails()).map((detail) => detail.path);
  }

  async resolveSkillCommand(content: string): Promise<string | null> {
    if (!content.startsWith("/")) return null;
    const spaceIdx = content.indexOf(" ");
    const command = spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();
    const detail = await this.getSkillDetail(command);
    if (!detail) return null;

    let prompt = `Base directory for this skill: ${join(this.skillsDir, detail.dirName)}\n\n${detail.content}`;
    const hasPositional = /\$[1-9]\d*/.test(prompt);
    if (hasPositional) {
      const parsed = args.split(" ");
      for (let i = 0; i < parsed.length; i++) {
        prompt = prompt.replace(new RegExp(`\\$${i + 1}\\b`, "g"), parsed[i] || "");
      }
    }
    if (prompt.includes("$ARGUMENTS")) {
      prompt = prompt.replace(/\$ARGUMENTS/g, args || "");
    } else if (!hasPositional && args) {
      prompt += `\n\nArguments: ${args}`;
    }
    return prompt;
  }
}
