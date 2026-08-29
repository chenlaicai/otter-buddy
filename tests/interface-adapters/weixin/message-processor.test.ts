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
    await ctx.processor.process({ fromUserId: "u-1", body: "在吗" });
    expect(ctx.sentMessages[0]).toMatchObject({ source: "weixin", body: "在吗" });
    expect(ctx.dispatched[0]).toEqual({ conversationId: "conv-1", content: "在吗", senderId: "u-1" });
  });

  it("未绑定会话：引导提示先 /in", async () => {
    const ctx = makeProcessor();
    await ctx.processor.process({ fromUserId: "u-1", body: "在吗" });
    expect(ctx.replies[0]).toContain("/in");
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it("/list 命令：走命令分支，不进对话", async () => {
    const ctx = makeProcessor();
    await ctx.processor.process({ fromUserId: "u-1", body: "/list" });
    expect(ctx.replies.length).toBeGreaterThan(0);
    expect(ctx.sentMessages).toHaveLength(0);
  });

  it("命令门禁：配置 partnerUserId 后非搭档被拒", async () => {
    const ctx = makeProcessor({ partnerResolver: { configured: true, isPartner: vi.fn().mockReturnValue(false) } });
    await ctx.processor.process({ fromUserId: "u-1", body: "/list" });
    expect(ctx.replies[0]).toContain("不对所有人开放");
  });

  it("空文本（媒体消息，PR③ 前占位）", async () => {
    const ctx = makeProcessor();
    ctx.manageConnection.getCurrentConversation.mockResolvedValue({ id: "conv-1", title: "t" });
    await ctx.processor.process({ fromUserId: "u-1", body: "" });
    expect(String(ctx.sentMessages[0].body)).toContain("媒体消息");
  });
});
