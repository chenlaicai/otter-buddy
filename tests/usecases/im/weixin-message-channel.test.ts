import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { WeixinMessageChannel } from "@usecases/im/weixin-message-channel";
import type { SSEEvent } from "@contract/sse/events";

/**
 * issue #565：微信出站通道测试。
 * F20260913ctlv 处置轮重写：消息级 broadcast 链路已删——出站走事件通道
 * （entry.speak 獭气泡 / entry.user Web 用户消息同步，source 防回环闸）。
 * 副作用断言风格：记录 gateway 实际出站内容。
 */
function userEntryEvent(overrides: Partial<{ body: string; source: string }> = {}): SSEEvent {
  return {
    event: "entry.user",
    data: {
      entryId: "entry-1", sequenceNum: 1, senderId: "user",
      body: overrides.body ?? "你好呀", createdAt: new Date().toISOString(),
      yieldTargets: undefined,
      source: overrides.source ?? "web",
    },
  } as never;
}

function speakEvent(overrides: Partial<{ body: string; otterName: string }> = {}): SSEEvent {
  return {
    event: "entry.speak",
    data: { body: overrides.body ?? "你好呀", otterName: overrides.otterName ?? "大獭" },
  } as never;
}

function createBroadcaster() {
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
    // F20260922wxeg：真实 resolveReplyTarget 语义（bot 锚 connection 走 metadata.lastChatId，
    // 普通连接直用 externalId）——出站目标断言必须穿透这层，否则锚分裂回归抓不到
    resolveReplyTarget: vi.fn((conn: { externalId: string; externalType: string; metadata?: Record<string, unknown> | null }) => {
      if (conn.externalType === "weixin" && conn.externalId.startsWith("weixin-")) {
        const last = conn.metadata?.lastChatId;
        return typeof last === "string" ? last : null;
      }
      if (conn.externalType === "feishu" && conn.externalId.startsWith("feishu-bot:")) {
        const last = conn.metadata?.lastChatId;
        return typeof last === "string" ? last : null;
      }
      return conn.externalId;
    }),
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

function bindWeixin(manageConnection: any, externalId = "wx-user-1", externalType = "weixin", metadata: Record<string, unknown> | null = null) {
  manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
  manageConnection.getConnection.mockResolvedValue({ id: "conn-1", externalId, externalType, metadata });
}

describe("WeixinMessageChannel（事件出站）", () => {
  it("entry.speak（獭气泡）广播到绑定的微信会话", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1");
    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("wx-user-1");
    expect(ctx.replies[0].label).toBe("大獭");
    expect(ctx.replies[0].text).toContain("你好呀");
  });

  it("source=web 的 user entry 同步到微信（Web→IM 补链）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1");
    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "网页发的" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("wx-user-1");
    expect(ctx.replies[0].label).toBe("用户");
    expect(ctx.replies[0].text).toContain("网页发的");
  });

  it("source=weixin 的 user entry 不回投（防回环闸）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent({ source: "weixin" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(0);
  });

  it("source 缺失（旧事件形态）不投递——保守防回环", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    const evt = userEntryEvent();
    delete (evt.data as Record<string, unknown>).source;
    ctx.broadcaster.broadcastEvent("conv-1", evt);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(0);
  });

  it("无绑定会话时静默跳过", async () => {
    const ctx = createBroadcaster();
    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(0);
  });

  it("出站失败不阻塞（fire-and-forget catch）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection);
    ctx.weixinGateway.replyMarkdown.mockRejectedValueOnce(new Error("weixin down"));
    // 不应抛错（onEvent 内部 catch）
    expect(() => ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("WeixinMessageChannel 按 externalType 路由（F20260831xtrt）", () => {
  it("externalType=feishu 的连接不投微信（飞书会话不进微信通道）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "chat-123", "feishu");

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.replies).toHaveLength(0);
    expect(ctx.weixinGateway.replyText).not.toHaveBeenCalled();
  });

  it("externalType=weixin 的连接正常投递（既有行为不回归）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "wx-user-1", "weixin");

    ctx.broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("wx-user-1");
  });
});

describe("WeixinMessageChannel onEvent thinking 按 externalType 路由（F20260831xtrt 检视R1）", () => {
  it("externalType=feishu 的连接 thinking 消息不投微信（飞书会话不进微信通道）", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "chat-123", "feishu");

    ctx.broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
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
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("wx-user-1");
    expect(sent[0].text).toBe("大獭 正在思考...");
  });
});

describe("WeixinMessageChannel 出站目标锚（F20260922wxeg：bot 锚 connection 经 metadata.lastChatId 定向）", () => {
  // 固化失败：9/21 现场——bot 锚 connection（externalId=weixin-muawxk7x）被当收信人，
  // context_token 表按用户 id 键查不到 → ret=-3 invalid arguments，微信侧零投递
  it("bot 锚 connection（externalId=weixin-*）：speak 投给 metadata.lastChatId 而非 bot 账号 id", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "weixin-muawxk7x", "weixin", { lastChatId: "o9cq8003MV3gt9XILrwg5RHYIgHg@im.wechat" });
    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("o9cq8003MV3gt9XILrwg5RHYIgHg@im.wechat");
  });

  it("bot 锚 connection 无 lastChatId（用户未说过话）：跳过发送不裸发给 bot 账号 id", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "weixin-muawxk7x", "weixin", null);
    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(0);
    // 副作用断言：跳过的可诊断性 = warn 日志留下「等用户先发消息」记录（不断言调用参数）
    const warned = ctx.logger.warn.mock.calls.length > 0;
    expect(warned).toBe(true);
  });

  it("旧时代按人建的 connection（externalId=用户 id）：直用 externalId 不回归", async () => {
    const ctx = createBroadcaster();
    bindWeixin(ctx.manageConnection, "o9cq8003MV3gt9XILrwg5RHYIgHg@im.wechat", "weixin");
    ctx.broadcaster.broadcastEvent("conv-1", speakEvent());
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0].to).toBe("o9cq8003MV3gt9XILrwg5RHYIgHg@im.wechat");
  });
});
