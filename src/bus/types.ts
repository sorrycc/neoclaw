export type ChannelName = "cli" | "telegram" | "dingtalk" | "feishu" | "system";

export interface InboundMessage {
  channel: ChannelName;
  senderId: string;
  chatId: string;
  content: string;
  timestamp: Date;
  media: string[];
  metadata: Record<string, unknown>;
}

export interface OutboundMessage {
  channel: ChannelName;
  chatId: string;
  content: string;
  replyTo?: string;
  media: string[];
  metadata: Record<string, unknown>;
}

export function sessionKey(msg: InboundMessage): string {
  return `${msg.channel}:${msg.chatId}`;
}

export function replyTarget(msg: InboundMessage): Pick<OutboundMessage, "channel" | "chatId"> {
  const originChannel = msg.metadata.originChannel;
  const originChatId = msg.metadata.originChatId;

  return {
    channel: (typeof originChannel === "string" ? originChannel : msg.channel) as ChannelName,
    chatId: typeof originChatId === "string" ? originChatId : msg.chatId,
  };
}
