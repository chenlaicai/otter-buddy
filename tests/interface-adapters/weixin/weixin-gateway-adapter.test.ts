import { describe, it, expect, vi } from "vitest";
import { WeixinGatewayAdapter } from "@interface-adapters/weixin/weixin-gateway-adapter";
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";
import type { WeixinCdnClient } from "@frameworks/weixin/cdn/cdn-client";
import type { WeixinUploadedMedia } from "@frameworks/weixin/types";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** 出站网关测试：记录 sendTextMessage 的实际出站请求（副作用断言风格） */
function makeAdapter(contextTokens: Record<string, string> = {}, cdn?: Partial<WeixinCdnClient>) {
  const sent: Array<{ toUserId: string; contextToken?: string; text: string }> = [];
  const sentItems: Array<{ toUserId: string; contextToken?: string; items: unknown[] }> = [];
  const api = {
    sendTextMessage: vi.fn(async (p: { toUserId: string; contextToken?: string; text: string }) => {
      sent.push(p);
    }),
    sendMessageItems: vi.fn(async (p: { toUserId: string; contextToken?: string; items: unknown[] }) => {
      sentItems.push(p);
    }),
  } as unknown as WeixinApiClient;
  const accountStore = {
    loadContextTokens: vi.fn().mockReturnValue(contextTokens),
  } as unknown as WeixinAccountStore;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const uploaded: WeixinUploadedMedia[] = [];
  const cdnMock = {
    uploadFile: vi.fn(async (p: { buffer: Buffer; toUserId: string; mediaType: string }) => {
      const info: WeixinUploadedMedia = { filekey: `fk-${uploaded.length}`, downloadParam: `dl-${uploaded.length}`, aesKeyHex: Buffer.alloc(16, uploaded.length + 1).toString("hex"), fileSize: p.buffer.length, fileSizeCiphertext: 16 };
      uploaded.push(info);
      return info;
    }),
    ...cdn,
  } as unknown as WeixinCdnClient;
  const adapter = new WeixinGatewayAdapter({ api, accountStore, accountId: "acc-1", logger, cdn: cdnMock });
  return { adapter, sent, sentItems, logger, uploaded, cdnMock };
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

  it("replyMedia（图片）：上传后发 image item，aes_key 为 base64(hex) 编码", async () => {
    const tmp = path.join(os.tmpdir(), `wx-media-test-${Date.now()}.png`);
    await fs.writeFile(tmp, Buffer.from("fake-png-bytes"));
    try {
      const { adapter, sentItems, uploaded } = makeAdapter({ "u-1": "ctx-1" });
      await adapter.replyMedia("u-1", { filePath: tmp, fileName: "图.png", mimeType: "image/png", caption: "看图" });

      // caption 文本在前、媒体在后（逐 item 独立请求）
      expect(sentItems).toHaveLength(1); // sendMessageItems 一次调用携带 items 数组
      const items = sentItems[0]!.items as Array<{ type: number; text_item?: unknown; image_item?: { media: { aes_key: string; encrypt_query_param: string; encrypt_type: number }; mid_size: number } }>;
      expect(items).toHaveLength(2);
      expect(items[0]!.type).toBe(1);
      expect(items[1]!.type).toBe(2);
      expect(items[1]!.image_item!.media.aes_key).toBe(Buffer.from(uploaded[0]!.aesKeyHex, "hex").toString("base64"));
      expect(items[1]!.image_item!.media.encrypt_query_param).toBe("dl-0");
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });

  it("replyMedia（文件）：mime 非 image/video 走 FILE 路由，len 为明文大小字符串", async () => {
    const tmp = path.join(os.tmpdir(), `wx-media-test-${Date.now()}.pdf`);
    await fs.writeFile(tmp, Buffer.from("fake-pdf"));
    try {
      const { adapter, sentItems } = makeAdapter({ "u-1": "ctx-1" });
      await adapter.replyMedia("u-1", { filePath: tmp, fileName: "报告.pdf", mimeType: "application/pdf" });
      const items = sentItems[0]!.items as Array<{ type: number; file_item?: { file_name: string; len: string; media: { encrypt_query_param: string } } }>;
      expect(items).toHaveLength(1); // 无 caption
      expect(items[0]!.type).toBe(4);
      expect(items[0]!.file_item!.file_name).toBe("报告.pdf");
      expect(items[0]!.file_item!.len).toBe("8");
      expect(items[0]!.file_item!.media.encrypt_query_param).toBe("dl-0");
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });

  it("replyMedia：cdn 未注入时抛不支持（上游捕获降级）", async () => {
    const tmp = path.join(os.tmpdir(), `wx-media-test-${Date.now()}.png`);
    await fs.writeFile(tmp, Buffer.from("x"));
    try {
      const { adapter } = makeAdapter({ "u-1": "ctx-1" }, {});
      // 传空 cdn 覆盖 uploadFile 未定义 → adapter 侧有 cdn 注入，但 uploadFile 缺失会抛 TypeError；
      // 主要验证未注入路径：直接构造无 cdn 的 adapter
      const noCdnAdapter = new (await import("@interface-adapters/weixin/weixin-gateway-adapter")).WeixinGatewayAdapter({
        api: { sendTextMessage: vi.fn() } as never,
        accountStore: { loadContextTokens: vi.fn().mockReturnValue({}) } as never,
        accountId: "acc-1",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      });
      await expect(noCdnAdapter.replyMedia("u-1", { filePath: tmp, fileName: "x.png", mimeType: "image/png" })).rejects.toThrow(/cdn client not injected/);
      void adapter;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });
});
