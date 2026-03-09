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
  const dt = config.channels.dingtalk;
  const dtInfo = dt.enabled
    ? `✓ enabled (clientId: ${dt.clientId ? dt.clientId.slice(0, 10) + "..." : "not set"})`
    : "✗ disabled";
  lines.push(`  DingTalk: ${dtInfo}`);
  const fs = config.channels.feishu;
  const fsMode = fs.connectionMode || "websocket";
  const webhookInfo = fsMode === "webhook"
    ? `, webhook: http://${fs.webhookHost || "127.0.0.1"}:${fs.webhookPort || 3000}${(fs.webhookPath || "/feishu/events").startsWith("/") ? (fs.webhookPath || "/feishu/events") : `/${fs.webhookPath}`}`
    : "";
  const fsGuardInfo = fsMode === "webhook"
    ? `, guard: ${(fs.webhookMaxBodyBytes || 1024 * 1024) / 1024}KB/${fs.webhookBodyTimeoutMs || 10_000}ms/${fs.webhookRateLimitPerMin || 120}rpm`
    : "";
  const fsDedupInfo = `, dedup: memory${fs.dedupPersist ? "+disk" : ""}`;
  const fsInfo = fs.enabled
    ? `✓ enabled (appId: ${fs.appId ? fs.appId.slice(0, 10) + "..." : "not set"}, mode: ${fsMode}, mention: ${fs.requireMention !== false ? "on" : "off"}, allowFrom: ${fs.allowFrom.length}${webhookInfo}${fsGuardInfo}${fsDedupInfo})`
    : "✗ disabled";
  lines.push(`  Feishu:   ${fsInfo}`);
  const qq = config.channels.qq;
  const qqInfo = qq.enabled
    ? `✓ enabled (appId: ${qq.appId ? qq.appId.slice(0, 10) + "..." : "not set"}, mention: ${qq.requireMention !== false ? "on" : "off"}, allowFrom: ${qq.allowFrom.length}, intents: ${qq.wsIntentMask || 0}, dedup: memory${qq.dedupPersist ? "+disk" : ""})`
    : "✗ disabled";
  lines.push(`  QQ:       ${qqInfo}`);
  lines.push("");

  const jobs = cron.listJobs();
  lines.push(`Cron:      ${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"}`);
  lines.push(`Heartbeat: enabled`);

  return lines.join("\n");
}
