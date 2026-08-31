import { describe, it, expect, vi } from "vitest";
import { WeixinApiClient } from "@frameworks/weixin/api-client";

/**
 * 微信 ilink API 客户端单测（全 mock fetch，不出网）。
 * 断言风格对齐 tests/frameworks/feishu/client.test.ts：captureFetch 记录
 * 请求（url/headers/body），断言记录内容而非 mock 调用本身。
 * 协议契约来源：@tencent-weixin/openclaw-weixin@2.4.6 源码审计（issue #564/#565）。
 */
function captureFetch(respond: () => unknown = () => ({ ret: 0 })) {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: JSON.parse((init?.body as string) ?? "{}"),
    });
    return new Response(JSON.stringify(respond()), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

function ok(body: unknown): () => unknown {
  return () => body;
}

describe("WeixinApiClient", () => {
  it("请求头带协议契约字段（AuthorizationType/iLink-App-Id/X-WECHAT-UIN）", async () => {
    const { calls, restore } = captureFetch();
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "tok-1" });
      await api.requestQrCode();
      const h = calls[0].headers;
      expect(h["AuthorizationType"]).toBe("ilink_bot_token");
      expect(h["iLink-App-Id"]).toBe("bot");
      expect(h["Authorization"]).toBe("Bearer tok-1");
      // X-WECHAT-UIN 是随机值，只断言存在 + base64 可解
      expect(typeof h["X-WECHAT-UIN"]).toBe("string");
      expect(() => atob(h["X-WECHAT-UIN"])).not.toThrow();
    } finally {
      restore();
    }
  });

  it("requestQrCode 打到 get_bot_qrcode 且 bot_type=3，响应透传", async () => {
    const { calls, restore } = captureFetch(ok({ ret: 0, qrcode: "qr", qrcode_img_content: "https://x" }));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test/" });
      const resp = await api.requestQrCode();
      expect(calls[0].url).toBe("https://example.test/ilink/bot/get_bot_qrcode?bot_type=3");
      expect(resp.qrcode).toBe("qr");
    } finally {
      restore();
    }
  });

  it("pollQrStatus 用 GET + query 参数（协议例外，回归：POST 会被网关静默吞掉）", async () => {
    // 2026-08-31 真机验收发现：POST 形式的 get_qrcode_status 被网关静默返回
    // ret:1 无 status（幽灵响应），扫码事件永远收不到。回归锁定 GET + query。
    const { calls, restore } = captureFetch(ok({ ret: 0, status: "wait" }));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test" });
      const resp = await api.pollQrStatus({ qrcode: "qr 1/特殊" });
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toBe("https://example.test/ilink/bot/get_qrcode_status?qrcode=qr+1%2F%E7%89%B9%E6%AE%8A");
      expect(calls[0].body).toEqual({}); // 不携带 JSON body
      expect(resp.status).toBe("wait");
    } finally {
      restore();
    }
  });

  it("pollQrStatus 携带配对码时 verify_code 进 query", async () => {
    const { calls, restore } = captureFetch(ok({ ret: 0, status: "scaned" }));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test" });
      await api.pollQrStatus({ qrcode: "qr", verify_code: "1234" });
      expect(calls[0].url).toContain("verify_code=1234");
      expect(calls[0].method).toBe("GET");
    } finally {
      restore();
    }
  });

  it("pollQrStatus 长轮询超时视为 wait 继续（不抛错，与参考实现一致）", async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test" });
      const resp = await api.pollQrStatus({ qrcode: "qr" }, 20);
      expect(resp).toEqual({ status: "wait" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getUpdates 回传游标且响应携带新游标", async () => {
    const { calls, restore } = captureFetch(ok({ ret: 0, msgs: [], get_updates_buf: "buf-2" }));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "t" });
      const resp = await api.getUpdates("buf-1");
      expect(calls[0].url).toBe("https://example.test/ilink/bot/getupdates");
      expect(calls[0].body.get_updates_buf).toBe("buf-1");
      expect(resp.get_updates_buf).toBe("buf-2");
    } finally {
      restore();
    }
  });

  it("sendTextMessage 组装协议消息结构（item type=1 / state=2 / bot_agent）", async () => {
    const { calls, restore } = captureFetch();
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "t" });
      await api.sendTextMessage({ toUserId: "u-1", contextToken: "ctx-1", text: "你好" });
      const msg = calls[0].body.msg as Record<string, any>;
      expect(msg.to_user_id).toBe("u-1");
      expect(msg.context_token).toBe("ctx-1");
      expect(msg.item_list[0].type).toBe(1);
      expect(msg.item_list[0].text_item.text).toBe("你好");
      expect(msg.message_state).toBe(2);
      expect(typeof msg.client_id).toBe("string");
      // bot_agent 自我声明（官方归因字段）
      expect((calls[0].body.base_info as any).bot_agent).toBe("OtterBuddy/0.1.0");
    } finally {
      restore();
    }
  });

  it("sendTextMessage ret≠0 时抛错（出站失败显式暴露）", async () => {
    const { restore } = captureFetch(ok({ ret: -14, errmsg: "stale token" }));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "t" });
      await expect(api.sendTextMessage({ toUserId: "u-1", text: "x" })).rejects.toThrow("ret=-14");
    } finally {
      restore();
    }
  });

  it("HTTP 非 2xx 抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test", token: "t" });
      await expect(api.getUpdates("")).rejects.toThrow("HTTP 502");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("baseUrl 尾部斜杠容错", async () => {
    const { calls, restore } = captureFetch();
    try {
      const api = new WeixinApiClient({ baseUrl: "https://example.test///" });
      await api.getUpdates("");
      expect(calls[0].url).toBe("https://example.test/ilink/bot/getupdates");
    } finally {
      restore();
    }
  });
});
