import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";

export interface CronJob {
  id: string;
  type: "at" | "every" | "cron";
  schedule: string | number;
  payload: { message: string; channel: string; chatId: string };
  lastRun?: string;
}

export class CronService {
  private jobs: CronJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private storePath: string;

  constructor(workspace: string, private bus: MessageBus) {
    const dataDir = join(workspace, "..", "data", "cron");
    mkdirSync(dataDir, { recursive: true });
    this.storePath = join(dataDir, "jobs.json");
    this.loadJobs();
  }

  private loadJobs(): void {
    if (existsSync(this.storePath)) {
      this.jobs = JSON.parse(readFileSync(this.storePath, "utf-8"));
    }
  }

  private saveJobs(): void {
    writeFileSync(this.storePath, JSON.stringify(this.jobs, null, 2), "utf-8");
  }

  async start(): Promise<void> {
    this.running = true;
    for (const job of this.jobs) this.armJob(job);

    while (this.running) {
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private armJob(job: CronJob): void {
    if (job.type === "at") {
      const delay = new Date(job.schedule as string).getTime() - Date.now();
      if (delay <= 0) return;
      this.timers.set(job.id, setTimeout(() => this.fireJob(job), delay));
    } else if (job.type === "every") {
      const fire = () => {
        this.fireJob(job);
        if (this.running) {
          this.timers.set(job.id, setTimeout(fire, job.schedule as number));
        }
      };
      this.timers.set(job.id, setTimeout(fire, job.schedule as number));
    } else if (job.type === "cron") {
      const scheduleNext = () => {
        try {
          const interval = parseExpression(job.schedule as string);
          const next = interval.next().getTime();
          const delay = next - Date.now();
          if (delay <= 0) return;
          this.timers.set(job.id, setTimeout(() => {
            this.fireJob(job);
            if (this.running) scheduleNext();
          }, delay));
        } catch {
          // invalid cron expression, skip
        }
      };
      scheduleNext();
    }
  }

  private fireJob(job: CronJob): void {
    const msg: InboundMessage = {
      channel: "system",
      senderId: "cron",
      chatId: `${job.payload.channel}:${job.payload.chatId}`,
      content: job.payload.message,
      timestamp: new Date(),
      media: [],
      metadata: { cronJobId: job.id, originChannel: job.payload.channel, originChatId: job.payload.chatId },
    };
    this.bus.publishInbound(msg);
    job.lastRun = new Date().toISOString();
    this.saveJobs();
  }

  addJob(opts: { type: CronJob["type"]; schedule: string | number; message: string; channel: string; chatId: string }): CronJob {
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      type: opts.type,
      schedule: opts.schedule,
      payload: { message: opts.message, channel: opts.channel, chatId: opts.chatId },
    };
    this.jobs.push(job);
    this.saveJobs();
    if (this.running) this.armJob(job);
    return job;
  }

  removeJob(jobId: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.jobs.splice(idx, 1);
    this.saveJobs();
    return true;
  }

  listJobs(): CronJob[] {
    return [...this.jobs];
  }
}
