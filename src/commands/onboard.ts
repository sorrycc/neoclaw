import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { createInterface } from "readline";
import {
  configPath,
  loadConfig,
  defaultConfig,
  ensureWorkspaceDirs,
} from "../config/schema.js";

const TEMPLATES: Record<string, string> = {
  "AGENTS.md": "AGENTS.md",
  "SOUL.md": "SOUL.md",
  "USER.md": "USER.md",
  "TOOLS.md": "TOOLS.md",
  "HEARTBEAT.md": "HEARTBEAT.md",
  "memory/MEMORY.md": "memory/MEMORY.md",
};

function bundledTemplatePath(pkgRoot: string, name: string): string {
  return join(pkgRoot, "workspace", name);
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function profileFlag(baseDir: string): string {
  const base = baseDir.replace(/\/$/, "");
  const name = base.split("/").pop() ?? "";
  if (name === ".neoclaw") return "";
  if (name === ".neoclaw-dev") return " --dev";
  const m = name.match(/^\.neoclaw-(.+)$/);
  return m ? ` --profile ${m[1]}` : "";
}

export async function handleOnboardCommand(baseDir: string, pkgRoot: string): Promise<void> {
  const cfgPath = configPath(baseDir);
  const defaults = defaultConfig(baseDir);

  if (existsSync(cfgPath)) {
    console.log(`Config already exists at ${cfgPath}`);
    console.log("  y = overwrite with defaults (existing values will be lost)");
    console.log(
      "  N = refresh config, keeping existing values and adding new fields",
    );
    const overwrite = await askYesNo("Overwrite? [y/N] ");
    if (overwrite) {
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf-8");
      console.log(`✓ Config reset to defaults at ${cfgPath}`);
    } else {
      const config = loadConfig(baseDir);
      writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");
      console.log(`✓ Config refreshed at ${cfgPath} (existing values preserved)`);
    }
  } else {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf-8");
    console.log(`✓ Created config at ${cfgPath}`);
  }

  const config = loadConfig(baseDir);
  const workspace = config.agent.workspace;
  ensureWorkspaceDirs(workspace);
  console.log(`✓ Workspace at ${workspace}`);

  for (const [dest, src] of Object.entries(TEMPLATES)) {
    const target = join(workspace, dest);
    if (existsSync(target)) continue;
    const srcPath = bundledTemplatePath(pkgRoot, src);
    if (!existsSync(srcPath)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(srcPath, "utf-8"));
    console.log(`  Created ${dest}`);
  }

  const bundledSkills = bundledTemplatePath(pkgRoot, "skills");
  if (existsSync(bundledSkills)) {
    const targetSkills = join(workspace, "skills");
    for (const name of readdirSync(bundledSkills)) {
      const dest = join(targetSkills, name);
      if (existsSync(dest)) continue;
      cpSync(join(bundledSkills, name), dest, { recursive: true });
      console.log(`  Created skills/${name}`);
    }
  }

  const flag = profileFlag(baseDir);
  console.log("\n[neoclaw] ready!");
  console.log("\nNext steps:");
  console.log("  1. Edit config at " + cfgPath);
  console.log(`  2. Run: neoclaw${flag}`);
}
