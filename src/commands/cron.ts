import type { CronService } from "../services/cron.js";

export function handleCronCommand(cronService: CronService, args: string[]): string {
  const action = args[0];

  if (!action || action === "list") {
    const jobs = cronService.listJobs();
    if (!jobs.length) return "No scheduled jobs.";
    return jobs.map((j) => `[${j.id}] ${j.type}(${j.schedule}) — ${j.payload.message}`).join("\n");
  }

  if (action === "remove") {
    const id = args[1];
    if (!id) return "Usage: cron remove <id>";
    return cronService.removeJob(id) ? `Removed job ${id}` : `Job ${id} not found`;
  }

  if (action === "add") {
    const flag = args[1];
    if (flag === "--every") {
      const seconds = parseInt(args[2], 10);
      if (isNaN(seconds) || seconds <= 0) return "Usage: cron add --every <seconds> <message>";
      const message = args.slice(3).join(" ");
      if (!message) return "Usage: cron add --every <seconds> <message>";
      const job = cronService.addJob({ type: "every", schedule: seconds * 1000, message, channel: "cli", chatId: "cli" });
      return `Created job '${job.payload.message}' (id: ${job.id})`;
    }
    if (flag === "--at") {
      const at = args[2];
      if (!at) return "Usage: cron add --at <ISO datetime> <message>";
      const message = args.slice(3).join(" ");
      if (!message) return "Usage: cron add --at <ISO datetime> <message>";
      const job = cronService.addJob({ type: "at", schedule: at, message, channel: "cli", chatId: "cli" });
      return `Created job '${job.payload.message}' (id: ${job.id})`;
    }
    if (flag === "--cron") {
      const exprParts: string[] = [];
      let i = 2;
      for (; i < args.length; i++) {
        if (/^\d/.test(args[i]) || args[i] === "*") {
          exprParts.push(args[i]);
        } else {
          break;
        }
      }
      const expr = exprParts.join(" ");
      const message = args.slice(i).join(" ");
      if (!expr || !message) return "Usage: cron add --cron <expr> <message>";
      const job = cronService.addJob({ type: "cron", schedule: expr, message, channel: "cli", chatId: "cli" });
      return `Created job '${job.payload.message}' (id: ${job.id})`;
    }
    return "Usage: cron add --every|--at|--cron <value> <message>";
  }

  return "Unknown cron action. Use: list, add, remove";
}
