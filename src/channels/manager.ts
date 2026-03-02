import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { Config } from "../config/schema.js";
import { logger } from "../logger.js";
import { TelegramChannel } from "./telegram.js";
import { CLIChannel } from "./cli.js";
import { DingtalkChannel } from "./dingtalk.js";

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
    if (config.channels.dingtalk.enabled) {
      this.channels.set("dingtalk", new DingtalkChannel(config.channels.dingtalk, bus));
    }
  }

  async updateConfig(newConfig: Config): Promise<void> {
    const oldConfig = this.config;
    this.config = newConfig;

    // CLI
    if (newConfig.channels.cli.enabled && !this.channels.has("cli")) {
      const cli = new CLIChannel(this.bus);
      this.channels.set("cli", cli);
      if (this.running) await cli.start();
    } else if (!newConfig.channels.cli.enabled && this.channels.has("cli")) {
      await this.channels.get("cli")!.stop();
      this.channels.delete("cli");
    } else if (newConfig.channels.cli.enabled && this.channels.has("cli")) {
      this.channels.get("cli")!.updateConfig?.(newConfig.channels.cli);
    }

    // Telegram
    if (newConfig.channels.telegram.enabled && !this.channels.has("telegram")) {
      const tg = new TelegramChannel(newConfig.channels.telegram, this.bus, newConfig.agent.workspace);
      this.channels.set("telegram", tg);
      if (this.running) await tg.start();
    } else if (!newConfig.channels.telegram.enabled && this.channels.has("telegram")) {
      await this.channels.get("telegram")!.stop();
      this.channels.delete("telegram");
    } else if (newConfig.channels.telegram.enabled && this.channels.has("telegram")) {
      this.channels.get("telegram")!.updateConfig?.(newConfig.channels.telegram);
    }

    // Dingtalk
    if (newConfig.channels.dingtalk.enabled && !this.channels.has("dingtalk")) {
      const dt = new DingtalkChannel(newConfig.channels.dingtalk, this.bus);
      this.channels.set("dingtalk", dt);
      if (this.running) await dt.start();
    } else if (!newConfig.channels.dingtalk.enabled && this.channels.has("dingtalk")) {
      await this.channels.get("dingtalk")!.stop();
      this.channels.delete("dingtalk");
    } else if (newConfig.channels.dingtalk.enabled && this.channels.has("dingtalk")) {
      this.channels.get("dingtalk")!.updateConfig?.(newConfig.channels.dingtalk);
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
    this.bus.close();
    for (const c of this.channels.values()) await c.stop();
  }

  private async dispatchLoop(): Promise<void> {
    while (this.running) {
      const msg = await this.bus.consumeOutbound();
      if (!msg) break;
      if (msg.channel === "system") continue;
      const channel = this.channels.get(msg.channel);
      if (channel) {
        try {
          await channel.send(msg);
        } catch (err) {
          logger.error("dispatch", `failed to send to ${msg.channel} chatId=${msg.chatId}:`, err);
        }
      }
    }
  }
}
