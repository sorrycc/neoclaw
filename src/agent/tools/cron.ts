import { createTool, _zod as z } from "@neovate/code";
import type { CronService } from "../../services/cron.js";

export function createCronTool(opts: { cronService: CronService; channel: string; chatId: string }): ReturnType<typeof createTool> {
  const { cronService, channel, chatId } = opts;

  return createTool({
    name: "cron",
    description: "Schedule reminders and recurring tasks. Actions: add, list, remove.",
    parameters: z.object({
      action: z.enum(["add", "list", "remove"]).describe("Action to perform"),
      message: z.string().optional().describe("Reminder message (for add)"),
      every_seconds: z.number().optional().describe("Interval in seconds (for recurring tasks)"),
      cron_expr: z.string().optional().describe("Cron expression like '0 9 * * *' (for scheduled tasks)"),
      at: z.string().optional().describe("ISO datetime for one-time execution (e.g. '2026-02-12T10:30:00')"),
      job_id: z.string().optional().describe("Job ID (for remove)"),
    }),
    async execute(params) {
      if (params.action === "list") {
        const jobs = cronService.listJobs();
        if (!jobs.length) return { llmContent: "No scheduled jobs." };
        const lines = jobs.map((j) => `- ${j.payload.message} (id: ${j.id}, ${j.type}, schedule: ${j.schedule})`);
        return { llmContent: `Scheduled jobs:\n${lines.join("\n")}` };
      }

      if (params.action === "remove") {
        if (!params.job_id) return { llmContent: "Error: job_id is required for remove", isError: true };
        if (cronService.removeJob(params.job_id)) return { llmContent: `Removed job ${params.job_id}` };
        return { llmContent: `Job ${params.job_id} not found`, isError: true };
      }

      if (params.action === "add") {
        if (!params.message) return { llmContent: "Error: message is required for add", isError: true };
        let type: "at" | "every" | "cron";
        let schedule: string | number;
        if (params.every_seconds) {
          type = "every";
          schedule = params.every_seconds * 1000;
        } else if (params.cron_expr) {
          type = "cron";
          schedule = params.cron_expr;
        } else if (params.at) {
          type = "at";
          schedule = params.at;
        } else {
          return { llmContent: "Error: every_seconds, cron_expr, or at is required", isError: true };
        }
        const job = cronService.addJob({ type, schedule, message: params.message, channel, chatId });
        return { llmContent: `Created job '${job.payload.message}' (id: ${job.id})` };
      }

      return { llmContent: `Unknown action: ${params.action}`, isError: true };
    },
  });
}
