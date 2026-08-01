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

function createBroadcaster() {
  const manageConnection = {
    getSessionByConversation: vi.fn().mockResolvedValue(null),
    getConnection: vi.fn().mockResolvedValue(null),
  } as any;
  const feishuGateway = { replyText: vi.fn() } as any;
  const queryOtter = { getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "大獭" }) } as any;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  return new MessageBroadcaster(manageConnection, feishuGateway, queryOtter, logger);
}

describe("MessageBroadcaster", () => {
  describe("subscribe + broadcast", () => {
    it("broadcast 调用 onMessage 回调", () => {
      const broadcaster = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      const msg = mockMessage();
      broadcaster.broadcast(msg);

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("msg-1");
    });

    it("broadcast 不调用不同 conversation 的回调", () => {
      const broadcaster = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      broadcaster.broadcast(mockMessage({ conversationId: "conv-2" }));

      expect(received).toHaveLength(0);
    });
  });

  describe("subscribe + broadcastEvent", () => {
    it("broadcastEvent 调用 onEvent 回调", () => {
      const broadcaster = createBroadcaster();
      const received: Array<{ event: string; data: Record<string, unknown> }> = [];
      broadcaster.subscribe("conv-1", vi.fn(), (event) => { received.push(event); });

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: { messageId: "msg-1", otterId: "otter-1" } });

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe("message.start");
    });

    it("broadcastEvent 不调用未注册 onEvent 的订阅者", () => {
      const broadcaster = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); }); // 没传 onEvent

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      expect(received).toHaveLength(0);
    });

    it("broadcastEvent 不调用不同 conversation 的回调", () => {
      const broadcaster = createBroadcaster();
      const received: Array<{ event: string; data: Record<string, unknown> }> = [];
      broadcaster.subscribe("conv-1", vi.fn(), (event) => { received.push(event); });

      broadcaster.broadcastEvent("conv-2", { event: "message.start", data: {} });

      expect(received).toHaveLength(0);
    });
  });

  describe("unsubscribe", () => {
    it("取消订阅后不再收到消息和事件", () => {
      const broadcaster = createBroadcaster();
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

  describe("broadcastToFeishu name prefix", () => {
    it("otter 消息带名字前缀", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;
      const sent: Array<{ chatId: string; text: string }> = [];
      feishuGateway.replyText.mockImplementation(async (chatId: string, text: string) => { sent.push({ chatId, text }); });

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ senderType: "otter", senderId: "otter-1", body: "你好" }));

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe("[大獭] 你好");
    });

    it("user 消息带 [用户] 前缀", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;
      const sent: Array<{ chatId: string; text: string }> = [];
      feishuGateway.replyText.mockImplementation(async (chatId: string, text: string) => { sent.push({ chatId, text }); });

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ senderType: "user", senderId: "user-1", body: "hi" }));

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe("[用户] hi");
    });

    it("飞书来源消息不同步（防回环）", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;
      const sent: string[] = [];
      feishuGateway.replyText.mockImplementation(async (_chatId: string, text: string) => { sent.push(text); });

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ source: "feishu" }));

      expect(sent).toHaveLength(0);
    });
  });
});
