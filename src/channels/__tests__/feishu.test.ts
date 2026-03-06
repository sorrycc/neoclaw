import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { MessageBus } from "../../bus/message-bus.js";
import { FeishuChannel } from "../feishu.js";

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    enabled: true,
    appId: "cli_test",
    appSecret: "sec_test",
    allowFrom: [],
    connectionMode: "websocket",
    ...overrides,
  };
}

async function flushInboundDispatch(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function inboundBuffer(bus: MessageBus): any[] {
  return (bus as any).inbound.buffer as any[];
}

describe("FeishuChannel config validation", () => {
  it("rejects webhook mode without verificationToken", async () => {
    const ch = new FeishuChannel(
      makeConfig({
        connectionMode: "webhook",
        webhookHost: "127.0.0.1",
        webhookPort: 3000,
        webhookPath: "/feishu/events",
      }),
      new MessageBus(),
    );
    await expect(ch.start()).rejects.toThrow("verificationToken is required when connectionMode=webhook");
  });

  it("rejects empty appId/appSecret", async () => {
    const ch = new FeishuChannel(
      makeConfig({
        appId: "",
        appSecret: "",
      }),
      new MessageBus(),
    );
    await expect(ch.start()).rejects.toThrow("appId is required");
  });
});

describe("FeishuChannel send target routing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function runSendAndCapture(target: string): Promise<{ url: string; body: any }> {
    let messageUrl = "";
    let messageBody: any = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "token_x", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        messageUrl = url;
        messageBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    }) as typeof fetch;

    const ch = new FeishuChannel(makeConfig(), new MessageBus());
    await ch.send({
      channel: "feishu",
      chatId: target,
      content: "hello",
      media: [],
      metadata: {},
    });

    return { url: messageUrl, body: messageBody };
  }

  it("routes group/chat targets to chat_id", async () => {
    const { url, body } = await runSendAndCapture("group:oc_12345");
    expect(url).toContain("receive_id_type=chat_id");
    expect(body.receive_id).toBe("oc_12345");
  });

  it("routes dm target with ou_ to open_id", async () => {
    const { url, body } = await runSendAndCapture("dm:ou_abc");
    expect(url).toContain("receive_id_type=open_id");
    expect(body.receive_id).toBe("ou_abc");
  });

  it("routes user target to user_id", async () => {
    const { url, body } = await runSendAndCapture("user:u_001");
    expect(url).toContain("receive_id_type=user_id");
    expect(body.receive_id).toBe("u_001");
  });

  it("supports provider-prefixed target", async () => {
    const { url, body } = await runSendAndCapture("feishu:open_id:ou_provider");
    expect(url).toContain("receive_id_type=open_id");
    expect(body.receive_id).toBe("ou_provider");
  });

  it("skips progress outbound to avoid duplicate final send", async () => {
    let messageCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "token_x", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        messageCalls += 1;
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    }) as typeof fetch;

    const ch = new FeishuChannel(makeConfig(), new MessageBus());
    await ch.send({
      channel: "feishu",
      chatId: "chat:oc_1",
      content: "hello",
      media: [],
      metadata: { progress: true },
    });
    expect(messageCalls).toBe(0);
  });

  it("deduplicates same outbound content in 5 seconds", async () => {
    let messageCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "token_x", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        messageCalls += 1;
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    }) as typeof fetch;

    const ch = new FeishuChannel(makeConfig(), new MessageBus());
    const payload = {
      channel: "feishu" as const,
      chatId: "chat:oc_1",
      content: "hello",
      media: [],
      metadata: { progress: false },
    };
    await ch.send(payload);
    await ch.send(payload);
    expect(messageCalls).toBe(1);
  });
});

describe("FeishuChannel send failure injection", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when Feishu send endpoint returns non-zero code", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "token_x", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 9999, msg: "send failed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const ch = new FeishuChannel(makeConfig(), new MessageBus());
    await expect(
      ch.send({
        channel: "feishu",
        chatId: "chat:oc_1",
        content: "hello",
        media: [],
        metadata: {},
      }),
    ).rejects.toThrow("feishu send failed");
  });
});

describe("FeishuChannel parsing helpers", () => {
  it("parses rich post content including code and image placeholders", () => {
    const ch = new FeishuChannel(makeConfig(), new MessageBus()) as any;
    const raw = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: "text", text: "hello " },
            { tag: "code", text: "x=1" },
            { tag: "img", image_key: "img_x" },
          ],
          [
            { tag: "code_block", text: "const y = 2;" },
          ],
        ],
      },
    });
    const text = ch.parsePostPlainText(raw);
    expect(text).toContain("hello");
    expect(text).toContain("`x=1`");
    expect(text).toContain("[Image]");
    expect(text).toContain("const y = 2;");
  });

  it("detects bot mention in content at-tag and strips mention markup", () => {
    const ch = new FeishuChannel(makeConfig(), new MessageBus()) as any;
    ch.botOpenId = "ou_bot";
    const mentioned = ch.isMentioned({
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: "at", user_id: "ou_bot", text: "@bot" }, { tag: "text", text: " hi" }]],
        },
      }),
      mentions: [{ id: { open_id: "ou_other" } }],
    });
    expect(mentioned).toBe(true);

    const stripped = ch.stripMentionKeys('<at user_id="ou_bot">@bot</at> hi', []);
    expect(stripped).toBe("hi");
  });
});

describe("FeishuChannel inbound integration-like flow", () => {
  it("drops group message when requireMention=true and bot is not mentioned", async () => {
    const bus = new MessageBus();
    const ch = new FeishuChannel(
      makeConfig({
        requireMention: true,
      }),
      bus,
    ) as any;
    ch.botOpenId = "ou_bot";

    ch.handleInboundEventData({
      header: { event_id: "evt-001" },
      event: {
        sender: { sender_id: { open_id: "ou_sender" } },
        message: {
          message_id: "msg-001",
          chat_id: "oc_group_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello group" }),
          mentions: [],
        },
      },
    });

    await flushInboundDispatch();
    expect(inboundBuffer(bus).length).toBe(0);
  });

  it("accepts mentioned group message and strips mention key", async () => {
    const bus = new MessageBus();
    const ch = new FeishuChannel(
      makeConfig({
        requireMention: true,
      }),
      bus,
    ) as any;
    ch.botOpenId = "ou_bot";

    ch.handleInboundEventData({
      header: { event_id: "evt-002" },
      event: {
        sender: { sender_id: { open_id: "ou_sender" } },
        message: {
          message_id: "msg-002",
          chat_id: "oc_group_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hi there" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_bot" },
            },
          ],
        },
      },
    });

    await flushInboundDispatch();
    const inbound = await bus.consumeInbound();
    expect(inbound).toBeTruthy();
    expect(inbound?.chatId).toBe("chat_id:oc_group_1");
    expect(inbound?.content).toBe("hi there");
  });

  it("respects allowFrom and deduplicates retries by message id", async () => {
    const bus = new MessageBus();
    const ch = new FeishuChannel(
      makeConfig({
        allowFrom: ["ou_allowed"],
        requireMention: false,
      }),
      bus,
    ) as any;

    const blocked = {
      header: { event_id: "evt-allow-1" },
      event: {
        sender: { sender_id: { open_id: "ou_blocked" } },
        message: {
          message_id: "msg-allow-1",
          chat_id: "oc_group_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "blocked" }),
        },
      },
    };
    ch.handleInboundEventData(blocked);
    await flushInboundDispatch();
    expect(inboundBuffer(bus).length).toBe(0);

    const allowed = {
      header: { event_id: "evt-allow-2" },
      event: {
        sender: { sender_id: { open_id: "ou_allowed_123" } },
        message: {
          message_id: "msg-allow-2",
          chat_id: "oc_group_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello pass" }),
        },
      },
    };
    ch.handleInboundEventData(allowed);
    await flushInboundDispatch();
    const first = await bus.consumeInbound();
    expect(first?.content).toBe("hello pass");

    ch.handleInboundEventData({
      ...allowed,
      header: { event_id: "evt-allow-2-retry" },
    });
    await flushInboundDispatch();
    expect(inboundBuffer(bus).length).toBe(0);
  });
});

describe("FeishuChannel dedup persistence", () => {
  it("persists dedup map to disk and can reload", async () => {
    const file = join("/tmp", `neoclaw-feishu-dedup-${Date.now()}.json`);
    try {
      const ch1 = new FeishuChannel(
        makeConfig({
          dedupPersist: true,
          dedupFile: file,
        }),
        new MessageBus(),
      ) as any;

      expect(ch1.isDuplicate("evt-1")).toBe(false);
      expect(ch1.isDuplicate("evt-1")).toBe(true);
      await ch1.flushDedupToDisk(true);
      expect(existsSync(file)).toBe(true);
      const payload = JSON.parse(readFileSync(file, "utf-8")) as Record<string, number>;
      expect(payload["evt-1"]).toBeDefined();

      const ch2 = new FeishuChannel(
        makeConfig({
          dedupPersist: true,
          dedupFile: file,
        }),
        new MessageBus(),
      ) as any;
      await ch2.loadPersistentDedup();
      expect(ch2.isDuplicate("evt-1")).toBe(true);
    } finally {
      if (existsSync(file)) rmSync(file);
    }
  });
});

describe("FeishuChannel policy helpers", () => {
  it("webhook rate limit triggers after threshold", () => {
    const ch = new FeishuChannel(
      makeConfig({
        webhookRateLimitPerMin: 2,
      }),
      new MessageBus(),
    ) as any;
    const req = { socket: { remoteAddress: "127.0.0.1" } } as any;
    expect(ch.isWebhookRateLimited(req)).toBe(false);
    expect(ch.isWebhookRateLimited(req)).toBe(false);
    expect(ch.isWebhookRateLimited(req)).toBe(true);
  });

  it("reconnect delay stays within configured bounds", () => {
    const ch = new FeishuChannel(
      makeConfig({
        wsReconnectBaseMs: 100,
        wsReconnectMaxMs: 500,
      }),
      new MessageBus(),
    ) as any;
    for (let i = 0; i < 16; i++) {
      const delay = ch.nextReconnectDelay(i);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it("ignores invalid updateConfig payload and keeps previous config", () => {
    const ch = new FeishuChannel(
      makeConfig({
        connectionMode: "websocket",
      }),
      new MessageBus(),
    ) as any;
    ch.updateConfig({
      ...makeConfig({
        connectionMode: "webhook",
      }),
    });
    expect(ch.config.connectionMode).toBe("websocket");
  });
});
