import type { CronService } from "../services/cron.js";

export async function handleCronCommand(cronService: CronService, args: string[]): Promise<string> {
  const action = args[0];

  if (!action || action === "list") {
    const jobs = cronService.listJobs();
    if (!jobs.length) return "No scheduled jobs.";
    return jobs.map((j) => {
      const status = j.enabled ? "on" : "paused";
      const next = j.nextRun ? ` next: ${j.nextRun}` : "";
      return `[${j.id}] ${j.type}(${j.schedule}) [${status}]${next} — ${j.payload.message}`;
    }).join("\n");
  }

  if (action === "remove") {
    const id = args[1];
    if (!id) return "Usage: cron remove <id>";
    return (await cronService.removeJob(id)) ? `Removed job ${id}` : `Job ${id} not found`;
  }

  if (action === "pause") {
    const id = args[1];
    if (!id) return "Usage: cron pause <id>";
    return (await cronService.pauseJob(id)) ? `Paused job ${id}` : `Job ${id} not found`;
  }

  if (action === "resume") {
    const id = args[1];
    if (!id) return "Usage: cron resume <id>";
    return (await cronService.resumeJob(id)) ? `Resumed job ${id}` : `Job ${id} not found`;
  }

  if (action === "add") {
    const flag = args[1];
    try {
      if (flag === "--every") {
        const seconds = parseInt(args[2], 10);
        if (isNaN(seconds) || seconds <= 0) return "Usage: cron add --every <seconds> <message>";
        const message = args.slice(3).join(" ");
        if (!message) return "Usage: cron add --every <seconds> <message>";
        const job = await cronService.addJob({ type: "every", schedule: seconds, message, channel: "cli", chatId: "cli" });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      if (flag === "--at") {
        const at = args[2];
        if (!at) return "Usage: cron add --at <ISO datetime> <message>";
        const message = args.slice(3).join(" ");
        if (!message) return "Usage: cron add --at <ISO datetime> <message>";
        const job = await cronService.addJob({ type: "at", schedule: at, message, channel: "cli", chatId: "cli" });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      if (flag === "--cron") {
        // Cron expressions are always 5 fields — take args[2..6], rest is message
        const exprParts = args.slice(2, 7);
        const expr = exprParts.join(" ");
        const message = args.slice(7).join(" ");
        if (exprParts.length < 5 || !message) return "Usage: cron add --cron <min> <hour> <dom> <mon> <dow> <message>";
        const job = await cronService.addJob({ type: "cron", schedule: expr, message, channel: "cli", chatId: "cli" });
        return `Created job '${job.payload.message}' (id: ${job.id})`;
      }
      return "Usage: cron add --every|--at|--cron <value> <message>";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  return "Unknown cron action. Use: list, add, remove, pause, resume";
}
