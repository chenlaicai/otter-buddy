import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { WeixinMessageChannel } from "@usecases/im/weixin-message-channel";
import type { Message } from "@entities/conversation/message";

/**
 * issue #565：微信出站通道测试（照 message-broadcaster-feishu.test.ts 模式）。
 * 副作用断言风格：记录 gateway 实际出站内容。
 */
function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    talkingStonePassedTo: null,
    status: "completed",
    segments: [{ id: "seg-1", messageId: "msg-1", body: "你好呀", sequenceNum: 0, createdAt: "2026-08-29T00:00:00Z" }],
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    senderName: "",
    createdAt: "2026-08-29T00:00:00Z",
    completedAt: "2026-08-29T00:00:01Z",
    ...overrides,
  };
}

function createBroadcaster() {
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
  } as any;
  const replies: Array<{ to: string; label: string; text: string }> = [];
  const weixinGateway = {
    replyText: vi.fn(),
    replyMarkdown: vi.fn(async (to: string, label: string, text: string) => {
      replies.push({ to, label, text });
    }),
  } as any;
  const queryOtter = { getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "大獭" }) } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  broadcaster.registerOutboundChannel(
    "weixin-test-1",
    new WeixinMessageChannel(manageConnection, weixinGateway, queryOtter, logger),
  );
  return { broadcaster, manageConnection, weixinGateway, replies, logger };
}

function bindWeixin(manageConnection: any, externalId = "wx-user-1", externalType = "weixin") {
  manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
  manageConnection.getConnection.mockResolvedValue({ id: "conn-1", externalId, externalType });
}

describe("WeixinMessageChannel（broadcaster 出站）", () => {
  it("agent 完成消息广播到绑定的微信会话", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1");
    await ctx.broadcaster.broadcast(mockMessage());
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("wx-user-1");
    expect(ctx.replies[0].label).toBe("大獭");
    expect(ctx.replies[0].text).toContain("你好呀");
  });

  it("source=weixin 的消息不回投（防回环）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    await ctx.broadcaster.broadcast(mockMessage({ source: "weixin" }));
    expect(ctx.replies).toHaveLength(0);
  });

  it("user 消息不广播到微信（用户自己可见）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    await ctx.broadcaster.broadcast(mockMessage({ senderType: "user", senderId: "u-1" }));
    expect(ctx.replies).toHaveLength(0);
  });

  it("无绑定会话时静默跳过", async () => {
    const ctx = createBroadcaster();
    await ctx.broadcaster.broadcast(mockMessage());
    expect(ctx.replies).toHaveLength(0);
  });

  it("出站失败不阻塞（通道隔离）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    ctx.weixinGateway.replyMarkdown.mockRejectedValueOnce(new Error("weixin down"));
    // 不应抛错（broadcaster 逐通道 catch）
    await expect(ctx.broadcaster.broadcast(mockMessage())).resolves.toBeUndefined();
  });
});

describe("WeixinMessageChannel 按 externalType 路由（F20260831xtrt）", () => {
  it("externalType=feishu 的连接不投微信（飞书会话不进微信通道）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "chat-123", "feishu");

    await ctx.broadcaster.broadcast(mockMessage({ senderType: "otter" }));

    expect(ctx.replies).toHaveLength(0);
    expect(ctx.weixinGateway.replyText).not.toHaveBeenCalled();
  });

  it("externalType=weixin 的连接正常投递（既有行为不回归）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1", "weixin");

    await ctx.broadcaster.broadcast(mockMessage({ senderType: "otter" }));

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("wx-user-1");
  });
});

describe("WeixinMessageChannel onEvent thinking 按 externalType 路由（F20260831xtrt 检视R1）", () => {
  it("externalType=feishu 的连接 thinking 消息不投微信（飞书会话不进微信通道）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "chat-123", "feishu");

    ctx.broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.weixinGateway.replyText).not.toHaveBeenCalled();
  });

  it("externalType=weixin 的连接 thinking 正常发送（不回归）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1", "weixin");
    const sent: Array<{ to: string; text: string }> = [];
    ctx.weixinGateway.replyText.mockImplementation(async (to: string, text: string) => {
      sent.push({ to, text });
    });

    ctx.broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("wx-user-1");
    expect(sent[0].text).toBe("大獭 正在思考...");
  });
});
