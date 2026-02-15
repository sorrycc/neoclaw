import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { MessageBus } from "../bus/message-bus.js";
import type { InboundMessage } from "../bus/types.js";

export class HeartbeatService {
  private running = false;

  constructor(
    private workspace: string,
    private bus: MessageBus,
    private intervalMs: number = 30 * 60 * 1000
  ) {}

  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      await new Promise((r) => setTimeout(r, this.intervalMs));
      if (!this.running) break;

      const heartbeatPath = join(this.workspace, "HEARTBEAT.md");
      if (!existsSync(heartbeatPath)) continue;

      const content = readFileSync(heartbeatPath, "utf-8").trim();
      if (!content) continue;

      const msg: InboundMessage = {
        channel: "system",
        senderId: "heartbeat",
        chatId: "heartbeat",
        content: `[HEARTBEAT] Please review and act on the following tasks:\n\n${content}`,
        timestamp: new Date(),
        media: [],
        metadata: { source: "heartbeat" },
      };
      this.bus.publishInbound(msg);
    }
  }

  stop(): void {
    this.running = false;
  }
}
