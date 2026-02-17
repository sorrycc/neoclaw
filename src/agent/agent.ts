import type { InboundMessage, OutboundMessage } from "../bus/types.js";

export interface Agent {
  processMessage(msg: InboundMessage): AsyncGenerator<OutboundMessage>;
}
