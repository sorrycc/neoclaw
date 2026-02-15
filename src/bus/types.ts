export interface InboundMessage {
  channel: string;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  media: string[];
  metadata: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: string;
  chatId: string;
  content: string;
  replyTo?: string;
  media: string[];
  metadata: Record<string, unknown>;
}

export function sessionKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.chatId}`;
}
