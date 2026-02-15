import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";

interface CronJob {
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
}
