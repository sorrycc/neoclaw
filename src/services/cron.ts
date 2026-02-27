import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";
import { logger } from "../logger.js";

export interface CronJob {
  id: string;
  type: "at" | "every" | "cron";
  schedule: string | number; // seconds for "every", ISO string for "at", cron expr for "cron"
  payload: { message: string; channel: string; chatId: string };
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export class CronService {
  private jobs: CronJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private storePath: string;
  private stopResolve?: () => void;

  constructor(workspace: string, private bus: MessageBus) {
    const dataDir = join(workspace, "..", "data", "cron");
    mkdirSync(dataDir, { recursive: true });
    this.storePath = join(dataDir, "jobs.json");
  }

  async init(): Promise<void> {
    await this.loadJobs();
  }

  private async loadJobs(): Promise<void> {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = await readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(raw);
      // Migrate old jobs missing `enabled` field
      this.jobs = parsed.map((j: CronJob) => ({
        ...j,
        enabled: j.enabled ?? true,
      }));
    } catch (err) {
      logger.warn("cron", "failed to load jobs, starting fresh:", (err as Error).message);
      this.jobs = [];
    }
  }

  private async saveJobs(): Promise<void> {
    await writeFile(this.storePath, JSON.stringify(this.jobs, null, 2), "utf-8");
  }

  async start(): Promise<void> {
    this.running = true;
    for (const job of this.jobs) this.armJob(job);
    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.stopResolve?.();
  }

  private armJob(job: CronJob): void {
    if (!job.enabled) return;

    if (job.type === "at") {
      const delay = new Date(job.schedule as string).getTime() - Date.now();
      if (delay <= 0) return;
      job.nextRun = new Date(job.schedule as string).toISOString();
      this.timers.set(job.id, setTimeout(() => this.fireJob(job), delay));
    } else if (job.type === "every") {
      const ms = (job.schedule as number) * 1000;
      const fire = () => {
        this.fireJob(job);
        if (this.running) {
          job.nextRun = new Date(Date.now() + ms).toISOString();
          this.timers.set(job.id, setTimeout(fire, ms));
        }
      };
      job.nextRun = new Date(Date.now() + ms).toISOString();
      this.timers.set(job.id, setTimeout(fire, ms));
    } else if (job.type === "cron") {
      const scheduleNext = () => {
        try {
          const interval = parseExpression(job.schedule as string);
          const next = interval.next().getTime();
          const delay = next - Date.now();
          if (delay <= 0) return;
          job.nextRun = new Date(next).toISOString();
          this.timers.set(job.id, setTimeout(() => {
            this.fireJob(job);
            if (this.running) scheduleNext();
          }, delay));
        } catch {
          // invalid cron expression — already validated at add time
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

    if (job.type === "at") {
      const idx = this.jobs.indexOf(job);
      if (idx !== -1) this.jobs.splice(idx, 1);
      this.timers.delete(job.id);
    }

    this.saveJobs(); // fire-and-forget
  }

  async addJob(opts: { type: CronJob["type"]; schedule: string | number; message: string; channel: string; chatId: string }): Promise<CronJob> {
    // Validate input
    if (opts.type === "every") {
      const secs = Number(opts.schedule);
      if (!Number.isFinite(secs) || secs <= 0) {
        throw new Error("'every' schedule must be a positive number (seconds)");
      }
      opts.schedule = secs;
    } else if (opts.type === "at") {
      const date = new Date(opts.schedule as string);
      if (isNaN(date.getTime())) {
        throw new Error("'at' schedule must be a valid ISO datetime string");
      }
      if (date.getTime() <= Date.now()) {
        throw new Error("'at' schedule must be in the future");
      }
    } else if (opts.type === "cron") {
      try {
        parseExpression(opts.schedule as string);
      } catch {
        throw new Error(`Invalid cron expression: ${opts.schedule}`);
      }
    }

    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      type: opts.type,
      schedule: opts.schedule,
      payload: { message: opts.message, channel: opts.channel, chatId: opts.chatId },
      enabled: true,
    };
    this.jobs.push(job);
    await this.saveJobs();
    if (this.running) this.armJob(job);
    return job;
  }

  async removeJob(jobId: string): Promise<boolean> {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    this.jobs.splice(idx, 1);
    await this.saveJobs();
    return true;
  }

  async pauseJob(jobId: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    job.enabled = false;
    job.nextRun = undefined;
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }
    await this.saveJobs();
    return true;
  }

  async resumeJob(jobId: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;
    job.enabled = true;
    if (this.running) this.armJob(job);
    await this.saveJobs();
    return true;
  }

  listJobs(): CronJob[] {
    return [...this.jobs];
  }
}
