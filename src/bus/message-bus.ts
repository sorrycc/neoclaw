import { AsyncQueue } from "./async-queue.js";
import type { InboundMessage, OutboundMessage } from "./types.js";

export class MessageBus {
  readonly inbound = new AsyncQueue<InboundMessage>();
  readonly outbound = new AsyncQueue<OutboundMessage>();

  publishInbound(msg: InboundMessage): void {
    this.inbound.push(msg);
  }

  async consumeInbound(): Promise<InboundMessage | undefined> {
    return this.inbound.pop();
  }

  publishOutbound(msg: OutboundMessage): void {
    this.outbound.push(msg);
  }

  async consumeOutbound(): Promise<OutboundMessage | undefined> {
    return this.outbound.pop();
  }

  close(): void {
    this.inbound.close();
    this.outbound.close();
  }
}
