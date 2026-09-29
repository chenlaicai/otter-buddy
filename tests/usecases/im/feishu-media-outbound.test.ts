import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
import type { SSEEvent } from "@contract/sse/events";
import type { AttachmentRef } from "@entities/conversation/attachment";

/**
 * #902 媒体出站恢复：飞书通道附件消费测试。
 *
 * 三断点之二（飞书侧）的回归锁：
 * - entry.user（事件自带 attachments）→ projectForChannel 占位投影 + replyImage 真实投递
 * - entry.speak（事件载荷无 attachments）→ 按 entryId 补拉 → 同上
 * - 附件依赖未注入 → 降级纯文本（占位也没有，旧装配兼容）
 * - 图片发送失败 → 不阻塞（fire-and-forget catch），文本已投
 */

const IMG_REF: AttachmentRef = {
  id: "att-img-1", kind: "image", originalName: "cat.png",
  mimeType: "image/png", sizeBytes: 1024, width: 100, height: 100, caption: null,
};
const DOC_REF: AttachmentRef = {
  id: "att-doc-1", kind: "document", originalName: "report.pdf",
  mimeType: "application/pdf", sizeBytes: 2048, width: null, height: null, caption: null,
};

function userEntryEvent(attachments?: AttachmentRef[]): SSEEvent {
  return {
    event: "entry.user",
    data: {
      entryId: "entry-u-1", sequenceNum: 1, senderId: "user",
      body: "看这张图", createdAt: new Date().toISOString(),
      yieldTargets: undefined, source: "web",
      ...(attachments && attachments.length > 0 && { attachments }),
    },
  } as never;
}

function speakEvent(entryId = "entry-s-1"): SSEEvent {
  // speak 事件现阶段不带 attachments（写入源未就绪）——补拉路径的现场形态
  return {
    event: "entry.speak",
    data: { entryId, invokeId: "inv-1", otterId: "otter-1", body: "查收附件", otterName: "大獭" },
  } as never;
}

/** 附件实体最小 mock（Pick 语义：仅 getByIds 消费 filePath；as any 过实体全字段面） */
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
    resolveReplyTarget: vi.fn((conn: { externalId: string }) => conn.externalId),
  } as any;
  const sent: Array<{ chatId: string; label: string; markdown: string }> = [];
  const images: Array<{ chatId: string; filePath: string; fileName: string }> = [];
  const feishuGateway = {
    replyText: vi.fn(),
    replyMarkdown: vi.fn(async (chatId: string, label: string, markdown: string) => {
      sent.push({ chatId, label, markdown });
    }),
    replyImage: vi.fn(async (chatId: string, p: { filePath: string; fileName: string; mimeType: string }) => {
      images.push({ chatId, filePath: p.filePath, fileName: p.fileName });
    }),
  } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  broadcaster.registerOutboundChannel(
    "feishu",
    // #1194 合入后构造函数对象参数化（this.o.xxx）——#902 rebase 适配；
    // attachmentDeps 用 as never 过 Pick 结构（mock 面窄于实体全字段，运行时仅消费所用字段）
    new FeishuMessageChannel({
      manageConnection, feishuGateway, logger,
      webBaseUrl: "https://otter.app",
      ...(deps && { attachmentDeps: deps as never }),
    }),
  );
  const bind = (externalId = "chat-123", externalType = "feishu") => {
    manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
    manageConnection.getConnection.mockResolvedValue({ id: "conn-1", externalId, externalType });
  };
  return { broadcaster, bind, sent, images, feishuGateway, logger, manageConnection };
}

describe("FeishuMessageChannel 媒体出站（#902）", () => {
  it("entry.user 带附件：占位投影进 markdown + 图片真实投递（绝对路径）", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-img-1": "attachments/ab/cd/abcd.png" }),
      entryReader: { getEntryById: vi.fn() },
      storageRoot: "/data/attachments",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([IMG_REF]));
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].markdown).toContain("[图片: cat.png]");
    expect(ctx.sent[0].markdown).toContain("https://otter.app/conversations/conv-1");
    expect(ctx.images).toHaveLength(1);
    expect(ctx.images[0].filePath).toBe("/data/attachments/attachments/ab/cd/abcd.png");
    expect(ctx.images[0].fileName).toBe("cat.png");
  });

  it("document 附件：占位投影但不调 replyImage（飞书仅 image 分支）", async () => {
    const deps = {
      attachmentRepo: { getByIds: async () => [] },
      entryReader: { getEntryById: vi.fn() },
      storageRoot: "/data/attachments",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([DOC_REF]));
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].markdown).toContain("[文件: report.pdf (2.0KB)]");
    expect(ctx.images).toHaveLength(0);
    expect(ctx.feishuGateway.replyImage).not.toHaveBeenCalled();
  });

  it("entry.speak 事件载荷无附件：按 entryId 补拉成功 → 投影 + 图片投递", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-img-1": "attachments/ab/cd/abcd.png" }),
      entryReader: { getEntryById: vi.fn().mockResolvedValue({ attachments: [IMG_REF] }) },
      storageRoot: "/data/att",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent("entry-s-9"));
    await new Promise((r) => setTimeout(r, 10));

    // 副作用断言：补拉生效 = 投影/投递链路里出现该附件（不绑定 mock 调用参数）
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].markdown).toContain("[图片: cat.png]");
    expect(ctx.images).toHaveLength(1);
  });

  it("补拉失败（entryReader 抛错）：降级纯文本，不阻塞投递", async () => {
    const deps = {
      attachmentRepo: { getByIds: async () => [] },
      entryReader: { getEntryById: vi.fn().mockRejectedValue(new Error("db down")) },
      storageRoot: "/data/att",
    };
    const ctx = createChannel(deps);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].markdown).not.toContain("[图片:");
    expect(ctx.images).toHaveLength(0);
  });

  it("附件依赖未注入（旧装配）：纯文本投递，不抛错", async () => {
    const ctx = createChannel(undefined);
    ctx.bind();

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent([IMG_REF]));
    await new Promise((r) => setTimeout(r, 10));

    // 占位投影仍生效（事件自带 attachments），但无图片真实投递
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].markdown).toContain("[图片: cat.png]");
    expect(ctx.images).toHaveLength(0);
  });

  it("图片投递失败（replyImage 抛错）：文本已投不回滚，其余附件继续", async () => {
    const deps = {
      attachmentRepo: fakeAttachmentRepo({ "att-img-1": "attachments/x.png", "att-img-2": "attachments/y.png" }),
      entryReader: { getEntryById: vi.fn().mockResolvedValue({ attachments: [IMG_REF, { ...IMG_REF, id: "att-img-2", originalName: "dog.png" }] }) },
      storageRoot: "/d",
    };
    const ctx = createChannel(deps);
    ctx.bind();
    ctx.feishuGateway.replyImage.mockRejectedValueOnce(new Error("feishu upload 429"));

    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.images).toHaveLength(1); // 第二张仍发出（单项失败不阻塞）
    expect(ctx.images[0].fileName).toBe("dog.png");
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
