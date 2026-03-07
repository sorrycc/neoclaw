import type { Channel } from "./channel.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { Config } from "../config/schema.js";
import type { ChannelName } from "../bus/types.js";
import { logger } from "../logger.js";
import { TelegramChannel } from "./telegram.js";
import { CLIChannel } from "./cli.js";
import { DingtalkChannel } from "./dingtalk.js";
import { FeishuChannel } from "./feishu.js";
import type { RuntimeStatusStore } from "../runtime/status-store.js";

const CHANNEL_KEYS: ChannelName[] = ["cli", "telegram", "dingtalk", "feishu"];

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private running = false;

  constructor(
    private config: Config,
    private bus: MessageBus,
    private statusStore?: RuntimeStatusStore,
  ) {
    this.syncConfiguredStatus(config);
    if (config.channels.cli.enabled) {
      this.channels.set("cli", new CLIChannel(bus));
    }
    if (config.channels.telegram.enabled) {
      this.channels.set("telegram", new TelegramChannel(config.channels.telegram, bus, config.agent.workspace));
    }
    if (config.channels.dingtalk.enabled) {
      this.channels.set("dingtalk", new DingtalkChannel(config.channels.dingtalk, bus));
    }
    if (config.channels.feishu.enabled) {
      this.channels.set("feishu", new FeishuChannel(config.channels.feishu, bus));
    }
  }

  async updateConfig(newConfig: Config): Promise<void> {
    this.config = newConfig;
    this.syncConfiguredStatus(newConfig);

    // CLI
    if (newConfig.channels.cli.enabled && !this.channels.has("cli")) {
      const cli = new CLIChannel(this.bus);
      this.channels.set("cli", cli);
      if (this.running) {
        void this.startChannel("cli", cli).catch((err) => logger.error("dispatch", "failed to start CLI channel:", err));
      }
    } else if (!newConfig.channels.cli.enabled && this.channels.has("cli")) {
      await this.stopChannel("cli", this.channels.get("cli")!);
      this.channels.delete("cli");
    } else if (newConfig.channels.cli.enabled && this.channels.has("cli")) {
      this.channels.get("cli")!.updateConfig?.(newConfig.channels.cli);
    }

    // Telegram
    if (newConfig.channels.telegram.enabled && !this.channels.has("telegram")) {
      const tg = new TelegramChannel(newConfig.channels.telegram, this.bus, newConfig.agent.workspace);
      this.channels.set("telegram", tg);
      if (this.running) {
        void this.startChannel("telegram", tg).catch((err) => logger.error("dispatch", "failed to start Telegram channel:", err));
      }
    } else if (!newConfig.channels.telegram.enabled && this.channels.has("telegram")) {
      await this.stopChannel("telegram", this.channels.get("telegram")!);
      this.channels.delete("telegram");
    } else if (newConfig.channels.telegram.enabled && this.channels.has("telegram")) {
      this.channels.get("telegram")!.updateConfig?.(newConfig.channels.telegram);
    }

    // DingTalk
    if (newConfig.channels.dingtalk.enabled && !this.channels.has("dingtalk")) {
      const dt = new DingtalkChannel(newConfig.channels.dingtalk, this.bus);
      this.channels.set("dingtalk", dt);
      if (this.running) {
        void this.startChannel("dingtalk", dt).catch((err) => logger.error("dispatch", "failed to start DingTalk channel:", err));
      }
    } else if (!newConfig.channels.dingtalk.enabled && this.channels.has("dingtalk")) {
      await this.stopChannel("dingtalk", this.channels.get("dingtalk")!);
      this.channels.delete("dingtalk");
    } else if (newConfig.channels.dingtalk.enabled && this.channels.has("dingtalk")) {
      this.channels.get("dingtalk")!.updateConfig?.(newConfig.channels.dingtalk);
    }

    // Feishu
    if (newConfig.channels.feishu.enabled && !this.channels.has("feishu")) {
      const fs = new FeishuChannel(newConfig.channels.feishu, this.bus);
      this.channels.set("feishu", fs);
      if (this.running) {
        void this.startChannel("feishu", fs).catch((err) => logger.error("dispatch", "failed to start Feishu channel:", err));
      }
    } else if (!newConfig.channels.feishu.enabled && this.channels.has("feishu")) {
      await this.stopChannel("feishu", this.channels.get("feishu")!);
      this.channels.delete("feishu");
    } else if (newConfig.channels.feishu.enabled && this.channels.has("feishu")) {
      this.channels.get("feishu")!.updateConfig?.(newConfig.channels.feishu);
    }
  }

  async startAll(): Promise<void> {
    this.running = true;
    const starts = Array.from(this.channels.entries()).map(([name, channel]) =>
      this.startChannel(name as ChannelName, channel),
    );
    await Promise.all([
      ...starts,
      this.dispatchLoop(),
    ]);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.bus.close();
    for (const [name, channel] of this.channels.entries()) {
      await this.stopChannel(name as ChannelName, channel);
    }
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
          this.statusStore?.markChannelError(msg.channel, err);
        }
      }
    }
  }

  private syncConfiguredStatus(config: Config): void {
    this.statusStore?.markChannelConfigured("cli", config.channels.cli.enabled);
    this.statusStore?.markChannelConfigured("telegram", config.channels.telegram.enabled);
    this.statusStore?.markChannelConfigured("dingtalk", config.channels.dingtalk.enabled);
    this.statusStore?.markChannelConfigured("feishu", config.channels.feishu.enabled);
    for (const name of CHANNEL_KEYS) {
      if (!this.channels.has(name)) {
        this.statusStore?.markChannelRunning(name, false);
      }
    }
  }

  private async startChannel(name: ChannelName, channel: Channel): Promise<void> {
    try {
      await channel.start();
      this.statusStore?.markChannelRunning(name, true);
    } catch (err) {
      this.statusStore?.markChannelError(name, err);
      throw err;
    }
  }

  private async stopChannel(name: ChannelName, channel: Channel): Promise<void> {
    try {
      await channel.stop();
    } finally {
      this.statusStore?.markChannelRunning(name, false);
    }
  }
}
