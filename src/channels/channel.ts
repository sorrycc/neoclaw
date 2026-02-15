import type { OutboundMessage } from "../bus/types.js";

export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
}
