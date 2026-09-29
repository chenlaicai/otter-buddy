import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { WeixinMessageChannel } from "@usecases/im/weixin-message-channel";
import type { SSEEvent } from "@contract/sse/events";
import type { AttachmentRef } from "@entities/conversation/attachment";

/**
 * #902 媒体出站恢复：微信通道附件消费测试。
 *
 * 三断点之三（微信侧）的回归锁：
 * - entry.user（事件自带 attachments）→ 占位投影 + replyMedia（CDN 上传）真实投递
 * - entry.speak（载荷无 attachments）→ entryId 补拉 → 同上
 * - 附件依赖未注入 → 降级占位投影（无真实投递）
 * - 单项媒体失败 → 不阻塞其余（占位已在文本里）
 */

const IMG_REF: AttachmentRef = {
  id: "att-1", kind: "image", originalName: "photo.jpg",
  mimeType: "image/jpeg", sizeBytes: 4096, width: null, height: null, caption: null,
};
const FILE_REF: AttachmentRef = {
  id: "att-2", kind: "document", originalName: "spec.pdf",
  mimeType: "application/pdf", sizeBytes: 8192, width: null, height: null, caption: null,
};

function userEntryEvent(attachments?: AttachmentRef[]): SSEEvent {
  return {
    event: "entry.user",
    data: {
      entryId: "entry-u-1", sequenceNum: 1, senderId: "user",
      body: "文件在这", createdAt: new Date().toISOString(),
      yieldTargets: undefined, source: "web",
      ...(attachments && attachments.length > 0 && { attachments }),
    },
  } as never;
}

function speakEvent(entryId = "entry-s-1"): SSEEvent {
  return {
    event: "entry.speak",
    data: { entryId, invokeId: "inv-1", otterId: "otter-1", body: "请看图", otterName: "大獭" },
  } as never;
}


/** 附件实体最小 mock（Pick 语义：仅 getByIds 消费 filePath） */
function fakeAttachmentRepo(files: Record<string, string>) {
  return {
    getByIds: async (ids: string[]) => ids.map((id) => ({ id, filePath: files[id] ?? `attachments/${id}.bin` })),
  };
}

function createChannel(attachmentDeps?: unknown) {
  const deps = attachmentDeps as {
    attachmentRepo: { getByIds: (ids: string[]) => Promise<Array<{ id: string; filePath: string }>> };
    entryReader: { getEntryById: (id: string) => Promise<{ attachments?: AttachmentRef[] } | null> };
    storageRoot: string;
  } | undefined;
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
    resolveReplyTarget: vi.fn((conn: { externalId: string; externalType: string }) => conn.externalId),
  } as any;
  const texts: Array<{ to: string; label: string; text: string }> = [];
  const media: Array<{ to: string; filePath: string; fileName: string; mimeType: string }> = [];
  const weixinGateway = {
    replyText: vi.fn(),
    replyMarkdown: vi.fn(async (to: string, label: string, text: string) => {
      texts.push({ to, label, text });
    }),
    replyMedia: vi.fn(async (to: string, p: { filePath: string; fileName: string; mimeType: string }) => {
      media.push({ to, ...p });
    }),
  } as any;
  const queryOtter = { getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "大獭" }) } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  broadcaster.registerOutboundChannel(
    "weixin-test",
    new WeixinMessageChannel(manageConnection, weixinGateway, queryOtter, logger, "https://otter.app", undefined, deps as never),
  );
  const bind = (externalId = "wx-user-1", externalType = "weixin") => {
    manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
    manageConnection.getConnection.mockResolvedValue({ id: "conn-1", externalId, externalType });
  };
  return { broadcaster, bind, texts, media, weixinGateway, logger };
}

describe("WeixinMessageChannel 媒体出站（#902）", () => {
  it("entry.user 带附件：文本在前（占位投影）+ 媒体在后（replyMedia 绝对路径）", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-1": "attachments/ab/cd/x.jpg" }),
      entryReader: { getEntryById: vi.fn() },
      storageRoot: "/data/attachments",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([IMG_REF]));
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.texts).toHaveLength(1);
    expect(ctx.texts[0].text).toContain("[图片: photo.jpg]");
    expect(ctx.media).toHaveLength(1);
    expect(ctx.media[0].filePath).toBe("/data/attachments/attachments/ab/cd/x.jpg");
    expect(ctx.media[0].fileName).toBe("photo.jpg");
    expect(ctx.media[0].mimeType).toBe("image/jpeg");
  });

  it("document 也走 replyMedia（微信 CDN 全类型路由，与飞书仅 image 不同）", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-2": "attachments/ef/gh/y.pdf" }),
      entryReader: { getEntryById: vi.fn() },
      storageRoot: "/data/attachments",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([FILE_REF]));
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.texts[0].text).toContain("[文件: spec.pdf (8.0KB)]");
    expect(ctx.media).toHaveLength(1);
  });

  it("entry.speak 载荷无附件：entryId 补拉 → 投影 + 媒体投递", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-1": "attachments/a.jpg" }),
      entryReader: { getEntryById: vi.fn().mockResolvedValue({ attachments: [IMG_REF] }) },
      storageRoot: "/d",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent("entry-s-7"));
    await new Promise((r) => setTimeout(r, 10));

    // 副作用断言：补拉生效 = 投影/媒体链路里出现该附件
    expect(ctx.texts).toHaveLength(1);
    expect(ctx.texts[0].label).toBe("大獭");
    expect(ctx.texts[0].text).toContain("[图片: photo.jpg]");
    expect(ctx.media).toHaveLength(1);
  });

  it("附件依赖未注入：占位投影仍生效，无媒体投递（r1-A5 后 debug 留痕不刷屏）", async () => {
    const ctx = createChannel(undefined);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([IMG_REF]));
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.texts).toHaveLength(1);
    expect(ctx.texts[0].text).toContain("[图片: photo.jpg]");
    expect(ctx.media).toHaveLength(0);
    expect(ctx.logger.debug).toHaveBeenCalled();
  });

  it("单项媒体失败不阻塞其余（占位已在文本里可见）", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({}),
      entryReader: { getEntryById: vi.fn().mockResolvedValue({ attachments: [IMG_REF, FILE_REF] }) },
      storageRoot: "/d",
    };
    const ctx = createChannel(deps);
    ctx.bind();
    ctx.weixinGateway.replyMedia.mockRejectedValueOnce(new Error("CDN 上传失败"));

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.media).toHaveLength(1); // 第二个附件仍发出
    expect(ctx.media[0].fileName).toBe("spec.pdf");
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("附件实体查不到（getByIds 空）：跳过该附件不抛错", async () => {
    const deps = {
      attachmentRepo: { getByIds: async () => [] },
      entryReader: { getEntryById: vi.fn().mockResolvedValue({ attachments: [IMG_REF] }) },
      storageRoot: "/d",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.texts).toHaveLength(1);
    expect(ctx.media).toHaveLength(0);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("r1-S1：文本投递失败（replyMarkdown 拒绝）→ 媒体仍投递（独立 try）", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-1": "attachments/a.jpg" }),
      entryReader: { getEntryById: vi.fn() },
      storageRoot: "/d",
    };
    const ctx = createChannel(deps);
    ctx.bind();
    ctx.weixinGateway.replyMarkdown.mockRejectedValueOnce(new Error("weixin cdn 5xx"));

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([IMG_REF]));
    await new Promise((r) => setTimeout(r, 10));

    // 文本失败不再吞媒体：replyMedia 照发
    expect(ctx.media).toHaveLength(1);
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
