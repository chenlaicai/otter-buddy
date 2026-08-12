import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeishuClient } from "@frameworks/feishu/client";

/** 捕获 fetch 调用参数(body 是 JSON 字符串,需解析) */
function captureFetch() {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    rawBody: string;
  }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const rawBody = (init?.body as string) ?? "";
    calls.push({
      url: _url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: JSON.parse(rawBody),
      rawBody,
    });
    return {
      json: async () => ({ code: 0, msg: "ok" }),
    } as unknown as Response;
  });
  return { fetchMock, calls };
}

function makeClient() {
  const config = { appId: "a", appSecret: "s" } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const tokenManager = { getAccessToken: vi.fn().mockResolvedValue("token-xxx") } as any;
  const client = new FeishuClient(config, logger, tokenManager);
  return { client, logger, tokenManager };
}

describe("FeishuClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("replyText", () => {
    it("发送 text 消息,使用正确的 msg_type 和 content", async () => {
      const { fetchMock, calls } = captureFetch();
      globalThis.fetch = fetchMock as any;
      const { client } = makeClient();

      await client.replyText("chat-1", "hello");

      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({
        receive_id: "chat-1",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      });
      expect(calls[0].headers.Authorization).toBe("Bearer token-xxx");
    });

    it("code !== 0 抛错", async () => {
      globalThis.fetch = vi.fn(async () => ({
        json: async () => ({ code: 230002, msg: "invalid chat" }),
      })) as any;
      const { client } = makeClient();

      await expect(client.replyText("bad", "x")).rejects.toThrow(/Failed to send message/);
    });
  });

  describe("replyMarkdown", () => {
    it("发送 post + md 消息,senderLabel 塞 title,markdown 塞 md.text", async () => {
      const { fetchMock, calls } = captureFetch();
      globalThis.fetch = fetchMock as any;
      const { client } = makeClient();

      await client.replyMarkdown("chat-9", "大獭", "# 标题\n\n正文");

      expect(calls).toHaveLength(1);
      const body = calls[0].body;
      expect(body.msg_type).toBe("post");
      expect(body.receive_id).toBe("chat-9");

      // content 是 JSON 字符串,二次解析
      const content = JSON.parse(body.content as string);
      expect(content).toEqual({
        zh_cn: {
          title: "[大獭]",
          content: [[{ tag: "md", text: "# 标题\n\n正文" }]],
        },
      });
    });

    it("code !== 0 时降级到 replyText,带 [纯文本降级] 前缀", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        // 第一次 post+md 失败,第二次 replyText 成功
        return {
          json: async () =>
            callCount === 1
              ? { code: 230002, msg: "post rejected" }
              : { code: 0, msg: "ok" },
        };
      }) as any;
      const { client } = makeClient();

      // 不应抛错(降级成功)
      await client.replyMarkdown("chat-1", "大獭", "# 标题");

      expect(callCount).toBe(2); // 触发降级:fetch 调用两次
    });

    it("网络错误时降级到 replyText", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("network timeout");
        return { json: async () => ({ code: 0, msg: "ok" }) };
      }) as any;
      const { client } = makeClient();

      await client.replyMarkdown("c", "大獭", "## H2");

      expect(callCount).toBe(2);
    });

    it("降级文本带 [纯文本降级] 前缀", async () => {
      const calls: Array<{ body: string }> = [];
      let callCount = 0;
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        callCount++;
        const rawBody = (init?.body as string) ?? "";
        calls.push({ body: rawBody });
        if (callCount === 1) {
          return { json: async () => ({ code: 9001, msg: "fail" }) };
        }
        return { json: async () => ({ code: 0, msg: "ok" }) };
      }) as any;
      const { client } = makeClient();

      await client.replyMarkdown("c", "大獭", "**x**");

      // 第二次调用的 content 应该是 { text: "[纯文本降级]\n\n**x**" }
      const second = JSON.parse(calls[1].body);
      expect(second.msg_type).toBe("text");
      const content = JSON.parse(second.content);
      expect(content.text).toBe("[纯文本降级]\n\n**x**");
    });

    it("成功时不触发降级", async () => {
      const { fetchMock, calls } = captureFetch();
      globalThis.fetch = fetchMock as any;
      const { client, logger } = makeClient();

      await client.replyMarkdown("c", "大獭", "正文");

      expect(calls).toHaveLength(1); // 只调用一次
      expect(logger.warn).not.toHaveBeenCalled();
      expect(calls[0].body.msg_type).toBe("post");
    });
  });
});
