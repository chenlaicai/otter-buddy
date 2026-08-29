import { describe, it, expect, vi } from "vitest";
import { WeixinGatewayAdapter } from "@interface-adapters/weixin/weixin-gateway-adapter";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";

/** 出站网关测试：记录 sendTextMessage 的实际出站请求（副作用断言风格） */
function makeAdapter(contextTokens: Record<string, string> = {}) {
  const sent: Array<{ toUserId: string; contextToken?: string; text: string }> = [];
  const api = {
    sendTextMessage: vi.fn(async (p: { toUserId: string; contextToken?: string; text: string }) => {
      sent.push(p);
    }),
  } as unknown as WeixinApiClient;
  const accountStore = {
    loadContextTokens: vi.fn().mockReturnValue(contextTokens),
  } as unknown as WeixinAccountStore;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const adapter = new WeixinGatewayAdapter({ api, accountStore, accountId: "acc-1", logger });
  return { adapter, sent, logger };
}

describe("WeixinGatewayAdapter", () => {
  it("replyText 回填 context_token", async () => {
    const { adapter, sent } = makeAdapter({ "u-1": "ctx-1" });
    await adapter.replyText("u-1", "hi");
    expect(sent[0]).toEqual({ toUserId: "u-1", contextToken: "ctx-1", text: "hi" });
  });

  it("无 context_token 降级裸发 + warn", async () => {
    const { adapter, sent, logger } = makeAdapter({});
    await adapter.replyText("u-1", "hi");
    expect(sent[0]).toEqual({ toUserId: "u-1", contextToken: undefined, text: "hi" });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("replyMarkdown 拼 senderLabel 前缀 + markdown 降噪", async () => {
    const { adapter, sent } = makeAdapter({ "u-1": "ctx-1" });
    await adapter.replyMarkdown("u-1", "大獭", "## 标题\n\n**加粗**和`代码`，[链接](https://x.test)去噪音");
    expect(sent[0].text).toContain("[大獭]");
    expect(sent[0].text).not.toContain("##");
    expect(sent[0].text).not.toContain("**");
    expect(sent[0].text).toContain("加粗");
    expect(sent[0].text).toContain("链接");
    expect(sent[0].text).not.toContain("https://x.test");
  });
});
