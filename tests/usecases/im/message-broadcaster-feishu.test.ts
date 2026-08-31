import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
import type { Message } from "@entities/conversation/message";
import type { SettingsRepository } from "@usecases/settings/settings-repository";


function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    talkingStonePassedTo: null,
    status: "completed",
    segments: [{ id: "seg-1", messageId: "msg-1", body: "hello", sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }],
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    senderName: "Test Otter",
    createdAt: "2026-07-31T00:00:00Z",
    completedAt: "2026-07-31T00:00:01Z",
    ...overrides,
  };
}

/** issue #281：broadcaster 拆为纯总线 + FeishuMessageChannel 出站通道。
 *  测试装配与生产一致：总线注册飞书通道，行为断言全部沿用 */
function createBroadcaster(webBaseUrl?: string, settingsRepo?: Pick<SettingsRepository, "get">) {
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
  } as any;
  const feishuGateway = {
    replyText: vi.fn(),
    replyMarkdown: vi.fn(),
  } as any;
  const queryOtter = { getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "大獭" }) } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  broadcaster.registerOutboundChannel(
    new FeishuMessageChannel(manageConnection, feishuGateway, queryOtter, logger, webBaseUrl, settingsRepo),
  );
  return { broadcaster, manageConnection, feishuGateway, queryOtter, logger };
}

/** 把 manageConnection mock 设置为有飞书绑定 */
function bindFeishu(broadcaster: MessageBroadcaster, externalId = "chat-123", externalType = "feishu") {
  const manageConnection = (broadcaster as any).messageChannels[0]["manageConnection"];
  manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
  manageConnection.getConnection.mockResolvedValue({ externalId, externalType });
}

describe("MessageBroadcaster 飞书 replyMarkdown 路径(F20260812fmdr)", () => {
  it("otter 消息走 replyMarkdown,senderLabel 为 otter 名", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
    bindFeishu(broadcaster);
    const sent: Array<{ chatId: string; senderLabel: string; markdown: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (chatId: string, senderLabel: string, markdown: string) => {
      sent.push({ chatId, senderLabel, markdown });
    });

    await broadcaster.broadcast(mockMessage({ senderType: "otter", senderId: "otter-1", segments: [{ id: "seg-1", messageId: "msg-1", body: "你好", sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }] }));

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("chat-123");
    expect(sent[0].senderLabel).toBe("大獭");
    expect(sent[0].markdown).toBe("你好");
  });

  it("user 消息 senderLabel 为 [用户]（无 settingsRepo 注入时保持原行为）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: Array<{ senderLabel: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, senderLabel: string) => {
      sent.push({ senderLabel });
    });

    await broadcaster.broadcast(mockMessage({ senderType: "user", senderId: "user-1", senderName: "", source: "web", segments: [{ id: "seg-1", messageId: "msg-1", body: "hi", sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }] }));

    expect(sent[0].senderLabel).toBe("用户");
  });

  it("html-card 围栏在飞书侧替换为 Web 链接占位符", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, _s: string, markdown: string) => {
      sent.push(markdown);
    });

    const body = '前文\n\n```html-card title="薪资对比"\n<div/>\n```\n\n后文';
    await broadcaster.broadcast(mockMessage({ segments: [{ id: "seg-1", messageId: "msg-1", body, sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }] }));

    expect(sent[0]).toBe(
      "前文\n\n【交互卡片:薪资对比】\n👉 https://otter.app/conversations/conv-1\n\n后文",
    );
  });

  it("webBaseUrl 缺省时占位符不带链接", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster(undefined);
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, _s: string, markdown: string) => {
      sent.push(markdown);
    });

    const body = '```html-card title="卡"\n<x/>\n```';
    await broadcaster.broadcast(mockMessage({ segments: [{ id: "seg-1", messageId: "msg-1", body, sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }] }));

    expect(sent[0]).toBe("【交互卡片:卡】");
  });

  it("飞书来源消息不同步(防回环)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    await broadcaster.broadcast(mockMessage({ source: "feishu" }));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("system 消息不广播到飞书", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    await broadcaster.broadcast(mockMessage({ senderType: "system" as const }));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
  });

  it("无飞书绑定时静默跳过", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    // manageConnection.getSessionByConversation 默认返回 null

    await broadcaster.broadcast(mockMessage());

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
  });
});

describe("MessageBroadcaster 飞书出站 user 标签（F20260828fsyc）", () => {
  /** 防回环（shouldBroadcastToFeishu）保证飞书出站的 user 消息只来自 Web——
   *  故标签语义 = 快照名（防御性,当前 web 消息恒无快照）> 搭档全局名 > 「用户」。
   *  飞书消息不出站（已有防回环用例覆盖），无渠道分叉分支 */
  function bindAndCapture(broadcaster: MessageBroadcaster, feishuGateway: any): Array<{ senderLabel: string; markdown: string }> {
    bindFeishu(broadcaster);
    const sent: Array<{ senderLabel: string; markdown: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, senderLabel: string, markdown: string) => {
      sent.push({ senderLabel, markdown });
    });
    return sent;
  }
  const seg = (body: string) => [{ id: "seg-fsyc", messageId: "msg-fsyc", body, sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }];
  /** #241 幂等去重：broadcast 用 mockMessage 默认 id="msg-1" 会被 LRU 撞掉——每条用例给唯一 id */
  let dedupSeq = 0;
  function nextMock(overrides: Partial<Message> = {}): Message {
    dedupSeq += 1;
    return mockMessage({ id: `msg-fsyc-${dedupSeq}`, ...overrides });
  }

  it("Web user 消息 → 显示搭档全局名（原硬编码「用户」）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockResolvedValue("chen") });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    await broadcaster.broadcast(nextMock({ senderType: "user", senderId: "user", source: "web", senderName: "", segments: seg("网页发的") }));

    expect(sent[0].senderLabel).toBe("chen");
    expect(sent[0].markdown).toBe("网页发的");
  });

  it("Web user 消息未设全局名 → 回退「用户」", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockResolvedValue(null) });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    await broadcaster.broadcast(nextMock({ senderType: "user", senderId: "user", source: "web", senderName: "", segments: seg("网页发的") }));

    expect(sent[0].senderLabel).toBe("用户");
  });

  it("未注入 settingsRepo → Web 消息回退「用户」（老调用方兼容）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
    const sent = bindAndCapture(broadcaster, feishuGateway);

    await broadcaster.broadcast(nextMock({ senderType: "user", senderId: "user", source: "web", senderName: "", segments: seg("网页发的") }));

    expect(sent[0].senderLabel).toBe("用户");
  });

  it("审视修复 R1：settings 读取抛异常 → 降级「用户」且广播不中断（标签解析失败不应吞掉投递）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockRejectedValue(new Error("db down")) });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    await broadcaster.broadcast(nextMock({ senderType: "user", senderId: "user", source: "web", senderName: "", segments: seg("正文不应丢") }));

    expect(sent[0].senderLabel).toBe("用户");
    expect(sent[0].markdown).toBe("正文不应丢");
  });

  it("user 消息带快照名 → 快照优先（防御性分支,当前链路 web 消息恒无快照）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockResolvedValue("chen") });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    await broadcaster.broadcast(nextMock({ senderType: "user", senderId: "user", source: "web", senderName: "自定义名", segments: seg("x") }));

    expect(sent[0].senderLabel).toBe("自定义名");
  });
});

describe("MessageBroadcaster message.start 触发飞书思考中消息(F20260812fmdr)", () => {
  it("message.start 事件触发 replyText 发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "msg-1", otterId: "otter-1", otterName: "大獭" },
    });

    // replyText 是异步触发,等微任务
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("无飞书绑定时,message.start 不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    // 默认无绑定

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("非 message.start 事件不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", {
      event: "tool.result",
      data: { toolName: "x" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("otterName 缺失时不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1" }, // 无 otterName
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("createdAt 距今 >3s 时跳过(审视 R5 乱序 gate)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    // createdAt 设为 5s 前,超过 THINKING_MESSAGE_MAX_DELAY_MS
    const staleCreatedAt = new Date(Date.now() - 5000).toISOString();
    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭", createdAt: staleCreatedAt },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("createdAt 距今 <3s 时正常发送", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    // createdAt 设为 100ms 前,在阈值内
    const freshCreatedAt = new Date(Date.now() - 100).toISOString();
    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭", createdAt: freshCreatedAt },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("createdAt 缺失时仍发送(向后兼容,旧事件无 createdAt)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("createdAt 非法字符串(NaN)时仍发送(审视 R6 NaN 语义)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭", createdAt: "not-a-date" },
    });
    await new Promise((r) => setTimeout(r, 10));

    // NaN 应被当作"无 gate 信息",继续发送
    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });
});

describe("FeishuMessageChannel 按 externalType 路由（F20260831xtrt）", () => {
  it("externalType=weixin 的连接不投飞书（微信会话误投噪音修复）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "wx-user-1", "weixin");

    await broadcaster.broadcast(mockMessage({ senderType: "otter" }));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("externalType=feishu 的连接正常投递（既有行为不回归）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "chat-123", "feishu");
    const sent: Array<{ chatId: string; markdown: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (chatId: string, _l: string, markdown: string) => {
      sent.push({ chatId, markdown });
    });

    await broadcaster.broadcast(mockMessage({ senderType: "otter" }));

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("chat-123");
  });

  it("onEvent thinking：externalType=weixin 的连接不投飞书（检视R1）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "wx-user-1", "weixin");

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("onEvent thinking：externalType=feishu 的连接正常发送（不回归）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "chat-123", "feishu");
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "message.start",
      data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });
});
