import { describe, it, expect, vi } from "vitest";
import { WeixinMessageProcessor } from "@interface-adapters/weixin/message-processor";

/**
 * issue #565：微信入站处理器测试（照 feishu message-processor 测试模式）。
 * 副作用断言风格：记录 sendMessage 收到的入参、gateway 出站的文本。
 */
function makeProcessor(overrides: Record<string, unknown> = {}) {
  const sentMessages: Array<Record<string, unknown>> = [];
  const replies: string[] = [];
  const dispatched: Array<{ conversationId: string; content: string; senderId: string }> = [];

  const manageConnection = {
    ensureConnection: vi.fn().mockResolvedValue({ id: "conn-1", externalId: "u-1" }),
    getCurrentConversation: vi.fn().mockResolvedValue(null),
    listActiveConversations: vi.fn().mockResolvedValue([]),
    enterConversation: vi.fn().mockResolvedValue(undefined),
    leaveConversation: vi.fn().mockResolvedValue(undefined),
  } as any;
  const sendMessage = {
    send: vi.fn(async (input: Record<string, unknown>) => {
      sentMessages.push(input);
      return { message: { id: "msg-1", conversationId: "conv-1", senderType: "user" }, mentionFeedback: null };
    }),
  } as any;
  const queryMessage = { getMessages: vi.fn().mockResolvedValue([]) } as any;
  const weixinGateway = {
    replyText: vi.fn(async (_u: string, text: string) => { replies.push(text); }),
  } as any;
  const partnerResolver = { configured: false, isPartner: vi.fn().mockReturnValue(false) } as any;
  const agentDispatchService = {
    dispatch: vi.fn(async (conversationId: string, content: string, senderId: string) => {
      dispatched.push({ conversationId, content, senderId });
      return {};
    }),
  } as any;
  const messageBroadcaster = { broadcast: vi.fn().mockResolvedValue(undefined) } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

  const processor = new WeixinMessageProcessor({
    manageConnection,
    sendMessage,
    queryMessage,
    weixinGateway,
    partnerResolver,
    agentDispatchService,
    messageBroadcaster,
    logger,
    ...overrides,
  } as any);
  return { processor, sentMessages, replies, dispatched, manageConnection, logger };
}

describe("WeixinMessageProcessor", () => {
  it("普通消息：入库（source=weixin）+ 广播 + agent 派发", async () => {
    const ctx = makeProcessor();
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });
    await ctx.processor.process({ fromUserId: "u-1", body: "在吗", raw: { item_list: [{ type: 1, text_item: { text: "在吗" } }] } });
    expect(ctx.sentMessages[0]).toMatchObject({ source: "weixin", body: "在吗" });
    expect(ctx.dispatched[0]).toEqual({ conversationId: "conv-1", content: "在吗", senderId: "u-1" });
  });

  it("未绑定会话：引导提示先 /in", async () => {
    const ctx = makeProcessor();
    await ctx.processor.process({ fromUserId: "u-1", body: "在吗", raw: { item_list: [] } });
    expect(ctx.replies[0]).toContain("/in");
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it("/list 命令：走命令分支，不进对话", async () => {
    const ctx = makeProcessor();
    await ctx.processor.process({ fromUserId: "u-1", body: "/list", raw: { item_list: [] } });
    expect(ctx.replies.length).toBeGreaterThan(0);
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it("命令门禁：配置 partnerUserId 后非搭档被拒", async () => {
    const ctx = makeProcessor({ partnerResolver: { configured: true, isPartner: vi.fn().mockReturnValue(false) } });
    await ctx.processor.process({ fromUserId: "u-1", body: "/list", raw: { item_list: [] } });
    expect(ctx.replies[0]).toContain("不对所有人开放");
  });

  it("空文本（无媒体时占位防空）", async () => {
    const ctx = makeProcessor();
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });
    await ctx.processor.process({ fromUserId: "u-1", body: "", raw: { item_list: [] } });
    expect(String(ctx.sentMessages[0].body)).toContain("媒体消息");
  });

  it("媒体消息：下载网关 → 附件管线入库 → attachmentIds 随消息 + 注入载荷随 dispatch", async () => {
    const uploadedIds: string[] = [];
    const ctx = makeProcessor({
      mediaGateway: {
        downloadMediaItem: vi.fn(async () => ({ fileName: "weixin-image-1.png", mimeType: "image/png", buffer: Buffer.from("media-bytes") })),
      },
      attachmentUpload: {
        upload: vi.fn(async (input: { originalName: string }) => {
          const id = `att-${uploadedIds.length}`;
          uploadedIds.push(id);
          return { id, kind: "image", originalName: input.originalName, mimeType: "image/png", sizeBytes: 11, filePath: "/tmp/x" };
        }),
      },
      attachmentInjection: {
        validateForSend: vi.fn(async () => undefined),
        buildInjectionPayload: vi.fn(async () => ({ images: [{ path: "/tmp/x" }], documentBlock: null })),
      },
    });
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });

    // 入站：图片（aeskey hex 优先）+ 文本
    await ctx.processor.process({
      fromUserId: "u-1",
      body: "看这张图",
      raw: {
        item_list: [
          { type: 1, text_item: { text: "看这张图" } },
          { type: 2, image_item: { aeskey: Buffer.alloc(16, 1).toString("hex"), media: { encrypt_query_param: "eq-1" } } },
        ],
      },
    });

    expect(uploadedIds).toHaveLength(1);
    expect(ctx.sentMessages[0].attachmentIds).toEqual(["att-0"]);
    expect(ctx.sentMessages[0].body).toBe("看这张图"); // 无降级时不拼提示
    // dispatch 带注入载荷（第 4 参数）
    const dispatchCall = (ctx as unknown as { dispatched: Array<{ content: string; injection?: unknown }> }).dispatched[0];
    expect(dispatchCall).toBeTruthy();
  });

  it("媒体单项失败：单项降级提示，其余照常（不丢消息）", async () => {
    let call = 0;
    const ctx = makeProcessor({
      mediaGateway: { downloadMediaItem: vi.fn(async () => { call += 1; if (call === 1) throw new Error("cdn down"); return { fileName: "x.png", mimeType: "image/png", buffer: Buffer.from("ok") }; }) },
      attachmentUpload: { upload: vi.fn(async () => ({ id: "att-ok", kind: "image", originalName: "x", mimeType: "image/png", sizeBytes: 2, filePath: "/tmp/y" })) },
      attachmentInjection: { validateForSend: vi.fn(async () => undefined), buildInjectionPayload: vi.fn(async () => ({})) },
    });
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });

    await ctx.processor.process({
      fromUserId: "u-1",
      body: "",
      raw: {
        item_list: [
          { type: 4, file_item: { media: { encrypt_query_param: "f1", aes_key: "bad" }, file_name: "a.pdf" } }, // 第 1 项失败（bad key）
          { type: 2, image_item: { aeskey: Buffer.alloc(16, 2).toString("hex"), media: { encrypt_query_param: "eq-2" } } }, // 第 2 项成功
        ],
      },
    });

    expect(String(ctx.sentMessages[0].body)).toContain("接收失败"); // 降级提示可见
    expect(ctx.sentMessages[0].attachmentIds).toEqual(["att-ok"]); // 成功项保留
  });

  it("管线未装配：媒体降级提示（旧部署不炸）", async () => {
    const ctx = makeProcessor();
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });
    await ctx.processor.process({
      fromUserId: "u-1",
      body: "",
      raw: { item_list: [{ type: 2, image_item: { aeskey: "11", media: { encrypt_query_param: "q" } } }] },
    });
    expect(String(ctx.sentMessages[0].body)).toContain("未启用附件功能");
    expect(ctx.sentMessages[0].attachmentIds).toBeUndefined();
  });
});
