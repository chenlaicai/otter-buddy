import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { FeishuMessageChannel } from "@usecases/im/feishu-message-channel";
import type { SSEEvent } from "@contract/sse/events";
import type { SettingsRepository } from "@usecases/settings/settings-repository";

/** F20260913ctlv 处置轮重写：消息级 broadcast 链路已删——出站全走事件通道。
 *  user 出站用例改走 entry.user 事件（source 防回环闸），语义断言沿用。 */

function userEntryEvent(overrides: Partial<{ body: string; source: string }> = {}): SSEEvent {
  return {
    event: "entry.user",
    data: {
      entryId: "entry-1", sequenceNum: 1, senderId: "user",
      body: overrides.body ?? "hello", createdAt: new Date().toISOString(),
      yieldTargets: undefined,
      source: overrides.source ?? "web",
    },
  } as never;
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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  broadcaster.registerOutboundChannel(
    "feishu",
    new FeishuMessageChannel(manageConnection, feishuGateway, logger, webBaseUrl, settingsRepo),
  );
  return { broadcaster, manageConnection, feishuGateway, logger };
}

/** 把 manageConnection mock 设置为有飞书绑定（#591 重构后出站通道存 Map，
 *  取通道改走 outboundChannels.get） */
function bindFeishu(broadcaster: MessageBroadcaster, externalId = "chat-123", externalType = "feishu") {
  const manageConnection = (broadcaster as any).outboundChannels.get("feishu")["manageConnection"];
  manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
  manageConnection.getConnection.mockResolvedValue({ externalId, externalType });
}

describe("Web→飞书用户消息同步（F20260828fsyc 恢复；entry.user 事件链）", () => {
  it("source=web 的 user entry 走 replyMarkdown", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
    bindFeishu(broadcaster);
    const sent: Array<{ chatId: string; senderLabel: string; markdown: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (chatId: string, senderLabel: string, markdown: string) => {
      sent.push({ chatId, senderLabel, markdown });
    });

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "你好" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("chat-123");
    expect(sent[0].markdown).toBe("你好");
  });

  it("user 消息 senderLabel 为「用户」（无 settingsRepo 注入时保持原行为）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: Array<{ senderLabel: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, senderLabel: string) => {
      sent.push({ senderLabel });
    });

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "hi" }));
    await new Promise((r) => setTimeout(r, 10));

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
    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body }));
    await new Promise((r) => setTimeout(r, 10));

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

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: '```html-card title="卡"\n<x/>\n```' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent[0]).toBe("【交互卡片:卡】");
  });

  it("飞书来源消息不同步（source=feishu 防回环闸）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ source: "feishu" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("微信来源消息不同步（source=weixin 防回环闸）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ source: "weixin" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
  });

  it("source 缺失（旧事件形态）不投递——保守防回环", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    const evt = userEntryEvent();
    delete (evt.data as Record<string, unknown>).source;
    broadcaster.broadcastEvent("conv-1", evt);
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
  });

  it("无飞书绑定时静默跳过", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    // manageConnection.getSessionByConversation 默认返回 null

    broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyMarkdown).not.toHaveBeenCalled();
  });
});

describe("Web→飞书 user 标签（F20260828fsyc）", () => {
  function bindAndCapture(broadcaster: MessageBroadcaster, feishuGateway: any): Array<{ senderLabel: string; markdown: string }> {
    bindFeishu(broadcaster);
    const sent: Array<{ senderLabel: string; markdown: string }> = [];
    feishuGateway.replyMarkdown.mockImplementation(async (_c: string, senderLabel: string, markdown: string) => {
      sent.push({ senderLabel, markdown });
    });
    return sent;
  }

  it("Web user 消息 → 显示搭档全局名（原硬编码「用户」）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockResolvedValue("chen") });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "网页发的" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent[0].senderLabel).toBe("chen");
    expect(sent[0].markdown).toBe("网页发的");
  });

  it("Web user 消息未设全局名 → 回退「用户」", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockResolvedValue(null) });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "网页发的" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent[0].senderLabel).toBe("用户");
  });

  it("未注入 settingsRepo → Web 消息回退「用户」（老调用方兼容）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
    const sent = bindAndCapture(broadcaster, feishuGateway);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "网页发的" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent[0].senderLabel).toBe("用户");
  });

  it("审视修复 R1：settings 读取抛异常 → 降级「用户」且投递不中断（标签解析失败不应吞掉投递）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app", { get: vi.fn().mockRejectedValue(new Error("db down")) });
    const sent = bindAndCapture(broadcaster, feishuGateway);

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "正文不应丢" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent[0].senderLabel).toBe("用户");
    expect(sent[0].markdown).toBe("正文不应丢");
  });
});

describe("MessageBroadcaster invoke.start 触发飞书思考中消息(F20260812fmdr；F20260913ctlv 批4a 换轨)", () => {
  it("invoke.start 事件触发 replyText 发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
    });

    // replyText 是异步触发,等微任务
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("无飞书绑定时,invoke.start 不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    // 默认无绑定

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("非 invoke.start 事件不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("otterName 缺失时不触发思考中消息", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", startedAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("startedAt 距今 >3s 时跳过(审视 R5 乱序 gate)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date(Date.now() - 4000).toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(feishuGateway.replyText).not.toHaveBeenCalled();
  });

  it("startedAt 距今 <3s 时正常发送", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("startedAt 缺失时仍发送(向后兼容,旧事件无时间戳)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });

  it("startedAt 非法字符串(NaN)时仍发送(审视 R6 NaN 语义)", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster);
    const sent: string[] = [];
    feishuGateway.replyText.mockImplementation(async (_c: string, text: string) => {
      sent.push(text);
    });

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: "not-a-date" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });
});

describe("FeishuMessageChannel 按 externalType 路由（F20260831xtrt）", () => {
  it("externalType=weixin 的连接不投飞书（微信会话误投噪音修复）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "wx-user-1", "weixin");

    broadcaster.broadcastEvent("conv-1", userEntryEvent());
    await new Promise((r) => setTimeout(r, 10));

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

    broadcaster.broadcastEvent("conv-1", userEntryEvent({ body: "你好" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("chat-123");
  });

  it("onEvent thinking：externalType=weixin 的连接不投飞书（检视R1）", async () => {
    const { broadcaster, feishuGateway } = createBroadcaster();
    bindFeishu(broadcaster, "wx-user-1", "weixin");

    broadcaster.broadcastEvent("conv-1", {
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
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
      event: "invoke.start",
      data: { invokeId: "inv-1", otterId: "otter-1", otterName: "大獭", startedAt: new Date().toISOString() },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual(["[大獭] 正在思考..."]);
  });
});
