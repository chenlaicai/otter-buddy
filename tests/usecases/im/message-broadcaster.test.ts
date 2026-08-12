import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Message } from "@entities/conversation/message";

function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    talkingStonePassedTo: null,
    status: "completed",
    body: "hello",
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    createdAt: "2026-07-31T00:00:00Z",
    completedAt: "2026-07-31T00:00:01Z",
    ...overrides,
  };
}

function createBroadcaster(webBaseUrl?: string) {
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
  const broadcaster = new MessageBroadcaster(manageConnection, feishuGateway, queryOtter, logger, webBaseUrl);
  return { broadcaster, manageConnection, feishuGateway, queryOtter, logger };
}

/** 把 manageConnection mock 设置为有飞书绑定 */
function bindFeishu(broadcaster: MessageBroadcaster, externalId = "chat-123") {
  const manageConnection = (broadcaster as any).manageConnection;
  manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
  manageConnection.getConnection.mockResolvedValue({ externalId });
}

describe("MessageBroadcaster", () => {
  describe("subscribe + broadcast", () => {
    it("broadcast 调用 onMessage 回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      const msg = mockMessage();
      broadcaster.broadcast(msg);

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("msg-1");
    });

    it("broadcast 不调用不同 conversation 的回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      broadcaster.broadcast(mockMessage({ conversationId: "conv-2" }));

      expect(received).toHaveLength(0);
    });
  });

  describe("subscribe + broadcastEvent", () => {
    it("broadcastEvent 调用 onEvent 回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: Array<{ event: string; data: Record<string, unknown> }> = [];
      broadcaster.subscribe("conv-1", vi.fn(), (event) => { received.push(event); });

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: { messageId: "msg-1", otterId: "otter-1" } });

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe("message.start");
    });

    it("broadcastEvent 不调用未注册 onEvent 的订阅者", () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); }); // 没传 onEvent

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      expect(received).toHaveLength(0);
    });

    it("broadcastEvent 不调用不同 conversation 的回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: Array<{ event: string; data: Record<string, unknown> }> = [];
      broadcaster.subscribe("conv-1", vi.fn(), (event) => { received.push(event); });

      broadcaster.broadcastEvent("conv-2", { event: "message.start", data: {} });

      expect(received).toHaveLength(0);
    });
  });

  describe("unsubscribe", () => {
    it("取消订阅后不再收到消息和事件", () => {
      const { broadcaster } = createBroadcaster();
      const receivedMessages: Message[] = [];
      const receivedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
      const unsubscribe = broadcaster.subscribe("conv-1", (msg) => { receivedMessages.push(msg); }, (event) => { receivedEvents.push(event); });

      unsubscribe();

      broadcaster.broadcast(mockMessage());
      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      expect(receivedMessages).toHaveLength(0);
      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe("broadcastToFeishu 走 replyMarkdown 路径(F20260812fmdr)", () => {
    it("otter 消息走 replyMarkdown,senderLabel 为 otter 名", async () => {
      const { broadcaster, feishuGateway } = createBroadcaster("https://otter.app");
      bindFeishu(broadcaster);
      const sent: Array<{ chatId: string; senderLabel: string; markdown: string }> = [];
      feishuGateway.replyMarkdown.mockImplementation(async (chatId: string, senderLabel: string, markdown: string) => {
        sent.push({ chatId, senderLabel, markdown });
      });

      await broadcaster.broadcast(mockMessage({ senderType: "otter", senderId: "otter-1", body: "你好" }));

      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe("chat-123");
      expect(sent[0].senderLabel).toBe("大獭");
      expect(sent[0].markdown).toBe("你好");
    });

    it("user 消息 senderLabel 为 [用户]", async () => {
      const { broadcaster, feishuGateway } = createBroadcaster();
      bindFeishu(broadcaster);
      const sent: Array<{ senderLabel: string }> = [];
      feishuGateway.replyMarkdown.mockImplementation(async (_c: string, senderLabel: string) => {
        sent.push({ senderLabel });
      });

      await broadcaster.broadcast(mockMessage({ senderType: "user", senderId: "user-1", body: "hi" }));

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
      await broadcaster.broadcast(mockMessage({ body }));

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
      await broadcaster.broadcast(mockMessage({ body }));

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

  describe("message.start 触发飞书思考中消息(F20260812fmdr)", () => {
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
        data: { messageId: "m1", otterId: "otter-1", otterName: "大獭" }, // 无 createdAt
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(sent).toEqual(["[大獭] 正在思考..."]);
    });
  });
});
