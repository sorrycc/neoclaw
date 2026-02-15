import * as readline from "readline";
import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { OutboundMessage, InboundMessage } from "../bus/types.js";

export class CLIChannel implements Channel {
  readonly name = "cli";
  private rl: readline.Interface | null = null;
  private running = false;

  constructor(private bus: MessageBus) {}

  async start(): Promise<void> {
    this.running = true;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("[neoclaw] CLI channel ready. Type a message (Ctrl+C to quit).");

    return new Promise<void>((resolve) => {
      this.rl!.on("line", (line) => {
        const content = line.trim();
        if (!content) return;

        const msg: InboundMessage = {
          channel: "cli",
          senderId: "local",
          chatId: "cli",
          content,
          timestamp: new Date(),
          media: [],
          metadata: {},
        };
        this.bus.publishInbound(msg);
      });

      this.rl!.on("close", () => {
        this.running = false;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
  }

  async send(msg: OutboundMessage): Promise<void> {
    console.log(`\n${msg.content}\n`);
  }
}
