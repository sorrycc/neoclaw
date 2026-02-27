import { existsSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { createInterface } from "readline";
import {
  configPath,
  loadConfig,
  defaultConfig,
  ensureWorkspaceDirs,
} from "../config/schema.js";
import { logger } from "../logger.js";

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

export interface OnboardOptions {
  baseDir: string;
  pkgRoot: string;
  profileFlag?: string;
  force?: boolean;
}

export async function handleOnboardCommand(opts: OnboardOptions): Promise<string> {
  const { baseDir, pkgRoot, profileFlag = "", force = false } = opts;
  const lines: string[] = [];
  const cfgPath = configPath(baseDir);
  const defaults = defaultConfig(baseDir);

  try {
    mkdirSync(dirname(cfgPath), { recursive: true });

    let workspace = defaults.agent.workspace;

    if (existsSync(cfgPath)) {
      let overwrite = force;
      if (!force) {
        console.log(`Config already exists at ${cfgPath}`);
        console.log("  y = overwrite with defaults (existing values will be lost)");
        console.log("  N = refresh config, keeping existing values and adding new fields");
        overwrite = await askYesNo("Overwrite? [y/N] ");
      }
      if (overwrite) {
        writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf-8");
        lines.push(`✓ Config reset to defaults at ${cfgPath}`);
      } else {
        const config = loadConfig(baseDir);
        workspace = config.agent.workspace;
        writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");
        lines.push(`✓ Config refreshed at ${cfgPath} (existing values preserved)`);
      }
    } else {
      writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf-8");
      lines.push(`✓ Created config at ${cfgPath}`);
    }

    ensureWorkspaceDirs(workspace);
    lines.push(`✓ Workspace at ${workspace}`);

    const bundledWorkspace = join(pkgRoot, "workspace");
    if (existsSync(bundledWorkspace)) {
      for (const srcFile of walkFiles(bundledWorkspace)) {
        const rel = relative(bundledWorkspace, srcFile);
        const target = join(workspace, rel);
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        cpSync(srcFile, target);
        lines.push(`  Created ${rel}`);
      }
    }

    lines.push("");
    lines.push("[neoclaw] ready!");
    lines.push("");
    lines.push("Next steps:");
    lines.push("  1. Edit config at " + cfgPath);
    lines.push(`  2. Run: neoclaw${profileFlag}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("onboard", msg);
    return `Error during onboard: ${msg}`;
  }

  return lines.join("\n");
}
