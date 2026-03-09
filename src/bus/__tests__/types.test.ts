import { describe, expect, it } from "bun:test";
import { replyTarget, type InboundMessage } from "../types.js";

describe("replyTarget", () => {
  it("prefers origin metadata when present", () => {
    const msg: InboundMessage = {
      channel: "system",
      senderId: "cron",
      chatId: "feishu:oc_123",
      content: "hello",
      timestamp: new Date("2026-03-06T00:00:00.000Z"),
      media: [],
      metadata: {
        originChannel: "feishu",
        originChatId: "oc_123",
      },
    };

    expect(replyTarget(msg)).toEqual({ channel: "feishu", chatId: "oc_123" });
  });

  it("falls back to the inbound target when origin metadata is absent", () => {
    const msg: InboundMessage = {
      channel: "telegram",
      senderId: "u1",
      chatId: "123",
      content: "hello",
      timestamp: new Date("2026-03-06T00:00:00.000Z"),
      media: [],
      metadata: {},
    };

    expect(replyTarget(msg)).toEqual({ channel: "telegram", chatId: "123" });
  });
});
