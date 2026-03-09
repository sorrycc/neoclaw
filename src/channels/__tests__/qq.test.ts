import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { MessageBus } from "../../bus/message-bus.js";
import { QQChannel, mapQQDispatchToInbound, resolveQQTarget, validateQQConfig } from "../qq.js";
import type { QQConfig } from "../../config/schema.js";

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return {
    enabled: true,
    appId: "app_123",
    clientSecret: "secret_456",
    allowFrom: [],
    requireMention: true,
    apiBase: "https://api.sgroup.qq.com",
    wsIntentMask: (1 << 30) | (1 << 12) | (1 << 25),
    wsReconnectBaseMs: 1000,
    wsReconnectMaxMs: 30_000,
    dedupPersist: false,
    dedupFile: "/tmp/qq-dedup.json",
    ...overrides,
  };
}

describe("QQ config and target helpers", () => {
  it("validates missing credentials", () => {
    expect(validateQQConfig(makeConfig({ appId: "", clientSecret: "" }))).toEqual([
      "appId is required",
      "clientSecret is required",
    ]);
  });

  it("parses private/group/channel targets", () => {
    expect(resolveQQTarget("qq:private:user_openid")).toEqual({ scene: "private", id: "user_openid" });
    expect(resolveQQTarget("group:group_openid")).toEqual({ scene: "group", id: "group_openid" });
    expect(resolveQQTarget("qqbot:channel:chan_1")).toEqual({ scene: "channel", id: "chan_1" });
  });
});

describe("QQ gateway event mapping", () => {
  it("maps c2c events to inbound messages", () => {
    const inbound = mapQQDispatchToInbound("C2C_MESSAGE_CREATE", {
      id: "msg_1",
      content: "hello",
      timestamp: "2026-03-08T10:00:00.000Z",
      author: { user_openid: "user_1" },
    }, makeConfig());

    expect(inbound?.chatId).toBe("qq:private:user_1");
    expect(inbound?.senderId).toBe("user_1|");
    expect(inbound?.metadata.sourceMessageId).toBe("msg_1");
  });

  it("maps group @ events and strips mention markup", () => {
    const inbound = mapQQDispatchToInbound("GROUP_AT_MESSAGE_CREATE", {
      id: "msg_2",
      content: "<@!bot> 帮我总结一下",
      timestamp: "2026-03-08T10:00:00.000Z",
      group_openid: "group_1",
      author: { member_openid: "member_1" },
    }, makeConfig());

    expect(inbound?.chatId).toBe("qq:group:group_1");
    expect(inbound?.content).toBe("帮我总结一下");
  });

  it("respects allowFrom", () => {
    const inbound = mapQQDispatchToInbound("C2C_MESSAGE_CREATE", {
      id: "msg_3",
      content: "hello",
      author: { user_openid: "blocked_user" },
    }, makeConfig({ allowFrom: ["allowed"] }));

    expect(inbound).toBeNull();
  });
});

describe("QQChannel send routing", () => {
  const originalFetch = globalThis.fetch;
  const tmpFile = join("/tmp", `qq-media-${Date.now()}.png`);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { unlinkSync(tmpFile); } catch {}
  });

  async function runSendAndCapture(target: string, opts?: { replyTo?: string; media?: string[] }): Promise<{ urls: string[]; bodies: any[] }> {
    const urls: string[] = [];
    const bodies: any[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/app/getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "token_x", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/files")) {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({ file_info: "file_info_x", ttl: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/messages")) {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({ id: "msg_ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    }) as typeof fetch;

    const ch = new QQChannel(makeConfig(), new MessageBus());
    await ch.send({ channel: "qq", chatId: target, content: "hello", replyTo: opts?.replyTo, media: opts?.media || [], metadata: {} });
    return { urls, bodies };
  }

  it("routes private targets to c2c endpoint", async () => {
    const { urls, bodies } = await runSendAndCapture("private:user_openid");
    expect(urls.some((url) => url.includes("/v2/users/user_openid/messages"))).toBe(true);
    expect(bodies.at(-1)?.content).toBe("hello");
  });

  it("routes group targets to group endpoint", async () => {
    const { urls } = await runSendAndCapture("qq:group:group_openid");
    expect(urls.some((url) => url.includes("/v2/groups/group_openid/messages"))).toBe(true);
  });

  it("routes channel targets to channel endpoint", async () => {
    const { urls, bodies } = await runSendAndCapture("channel:chan_1");
    expect(urls.some((url) => url.includes("/channels/chan_1/messages"))).toBe(true);
    expect(bodies.at(-1)?.msg_type).toBeUndefined();
  });

  it("passes replyTo as msg_id", async () => {
    const { bodies } = await runSendAndCapture("private:user_openid", { replyTo: "src_123" });
    expect(bodies.at(-1)?.msg_id).toBe("src_123");
  });

  it("uploads and sends remote image media", async () => {
    const { urls, bodies } = await runSendAndCapture("private:user_openid", { media: ["https://example.com/a.png"] });
    expect(urls.some((url) => url.includes("/v2/users/user_openid/files"))).toBe(true);
    expect(urls.some((url) => url.includes("/v2/users/user_openid/messages"))).toBe(true);
    expect(bodies[0]?.url).toBe("https://example.com/a.png");
    expect(bodies[1]?.msg_type).toBe(7);
    expect(bodies[1]?.media?.file_info).toBe("file_info_x");
  });

  it("uploads and sends local file media", async () => {
    writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { urls, bodies } = await runSendAndCapture("group:group_openid", { media: [tmpFile] });
    expect(urls.some((url) => url.includes("/v2/groups/group_openid/files"))).toBe(true);
    expect(typeof bodies[0]?.file_data).toBe("string");
    expect(bodies[1]?.msg_type).toBe(7);
  });

  it("skips progress outbound", async () => {
    let sendCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/app/getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "token_x", expires_in: 7200 }), { status: 200 });
      }
      if (url.includes("/messages")) sendCalls += 1;
      return new Response(JSON.stringify({ id: "msg_ok" }), { status: 200 });
    }) as typeof fetch;

    const ch = new QQChannel(makeConfig(), new MessageBus());
    await ch.send({ channel: "qq", chatId: "private:user_openid", content: "hello", media: [], metadata: { progress: true } });
    expect(sendCalls).toBe(0);
  });
});
