import { existsSync } from "fs";
import type { Config } from "../config/schema.js";
import { configPath } from "../config/schema.js";
import type { CronService } from "../services/cron.js";

export function handleStatusCommand(config: Config, cron: CronService, baseDir: string): string {
  const lines: string[] = ["[neoclaw] Status", ""];

  const cfgPath = configPath(baseDir);
  lines.push(`Config:    ${cfgPath} ${existsSync(cfgPath) ? "✓" : "✗"}`);
  lines.push(`Workspace: ${config.agent.workspace} ${existsSync(config.agent.workspace) ? "✓" : "✗"}`);
  lines.push(`Model:     ${config.agent.model}`);
  lines.push("");

  lines.push("Channels:");
  lines.push(`  CLI:      ${config.channels.cli.enabled ? "✓ enabled" : "✗ disabled"}`);
  const tg = config.channels.telegram;
  const tgInfo = tg.enabled
    ? `✓ enabled (token: ${tg.token ? tg.token.slice(0, 10) + "..." : "not set"})`
    : "✗ disabled";
  lines.push(`  Telegram: ${tgInfo}`);
  lines.push("");

  const jobs = cron.listJobs();
  lines.push(`Cron:      ${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"}`);
  lines.push(`Heartbeat: enabled`);

  return lines.join("\n");
}
