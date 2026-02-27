import type { ChannelName, OutboundMessage } from "../bus/types.js";

export interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  updateConfig?(config: unknown): void;
}
