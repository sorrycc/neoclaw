import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { Config } from "../config/schema.js";
import { TelegramChannel } from "./telegram.js";
import { CLIChannel } from "./cli.js";

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private running = true;

  constructor(private config: Config, private bus: MessageBus) {
    if (config.channels.cli.enabled) {
      this.channels.set("cli", new CLIChannel(bus));
    }
    if (config.channels.telegram.enabled) {
      this.channels.set("telegram", new TelegramChannel(config.channels.telegram, bus, config.agent.workspace));
    }
  }

  async startAll(): Promise<void> {
    await Promise.all([
      ...Array.from(this.channels.values()).map((c) => c.start()),
      this.dispatchLoop(),
    ]);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const c of this.channels.values()) await c.stop();
  }

  private async dispatchLoop(): Promise<void> {
    while (this.running) {
      const msg = await this.bus.consumeOutbound();
      if (msg.channel === "system") continue;
      const channel = this.channels.get(msg.channel);
      if (channel) {
        try {
          await channel.send(msg);
        } catch (err) {
          console.error(`[dispatch] failed to send to ${msg.channel}:`, err);
        }
      }
    }
  }
}
