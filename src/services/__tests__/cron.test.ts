import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { CronService } from "../cron.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

class TestBus {
  count = 0;

  publishInbound(): void {
    this.count += 1;
  }
}

describe("CronService", () => {
  it("does not duplicate timers when resuming an active job", async () => {
    const baseDir = join("/tmp", `neoclaw-cron-${Date.now()}`);
    const workspace = join(baseDir, "workspace");
    tmpDirs.push(baseDir);

    mkdirSync(workspace, { recursive: true });
    const bus = new TestBus();
    const cron = new CronService(workspace, bus as any);
    await cron.init();
    await cron.addJob({ type: "every", schedule: 1, message: "tick", channel: "cli", chatId: "cli" });

    const jobId = cron.listJobs()[0]!.id;
    const running = cron.start();
    await cron.resumeJob(jobId);
    await cron.resumeJob(jobId);
    await new Promise((resolve) => setTimeout(resolve, 1150));

    cron.stop();
    await running;

    expect(bus.count).toBe(1);
  });
});
