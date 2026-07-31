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
      const onMessage = vi.fn();
      broadcaster.subscribe("conv-1", onMessage);

      const msg = mockMessage();
      broadcaster.broadcast(msg);

      expect(onMessage).toHaveBeenCalledWith(msg);
    });

    it("broadcast 不调用不同 conversation 的回调", () => {
      const broadcaster = createBroadcaster();
      const onMessage = vi.fn();
      broadcaster.subscribe("conv-1", onMessage);

      broadcaster.broadcast(mockMessage({ conversationId: "conv-2" }));

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe("subscribe + broadcastEvent", () => {
    it("broadcastEvent 调用 onEvent 回调", () => {
      const broadcaster = createBroadcaster();
      const onEvent = vi.fn();
      broadcaster.subscribe("conv-1", vi.fn(), onEvent);

      const event = { event: "message.start", data: { messageId: "msg-1", otterId: "otter-1" } };
      broadcaster.broadcastEvent("conv-1", event);

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it("broadcastEvent 不调用未注册 onEvent 的订阅者", () => {
      const broadcaster = createBroadcaster();
      const onMessage = vi.fn();
      broadcaster.subscribe("conv-1", onMessage); // 没传 onEvent

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      // 不报错，不调用
      expect(onMessage).not.toHaveBeenCalled();
    });

    it("broadcastEvent 不调用不同 conversation 的回调", () => {
      const broadcaster = createBroadcaster();
      const onEvent = vi.fn();
      broadcaster.subscribe("conv-1", vi.fn(), onEvent);

      broadcaster.broadcastEvent("conv-2", { event: "message.start", data: {} });

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("取消订阅后不再收到消息和事件", () => {
      const broadcaster = createBroadcaster();
      const onMessage = vi.fn();
      const onEvent = vi.fn();
      const unsubscribe = broadcaster.subscribe("conv-1", onMessage, onEvent);

      unsubscribe();

      broadcaster.broadcast(mockMessage());
      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      expect(onMessage).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe("broadcastToFeishu name prefix", () => {
    it("otter 消息带名字前缀", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ senderType: "otter", senderId: "otter-1", body: "你好" }));

      expect(feishuGateway.replyText).toHaveBeenCalledWith("chat-123", "[大獭] 你好");
    });

    it("user 消息带 [用户] 前缀", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ senderType: "user", senderId: "user-1", body: "hi" }));

      expect(feishuGateway.replyText).toHaveBeenCalledWith("chat-123", "[用户] hi");
    });

    it("飞书来源消息不同步（防回环）", async () => {
      const broadcaster = createBroadcaster();
      const feishuGateway = (broadcaster as any).feishuGateway;
      const manageConnection = (broadcaster as any).manageConnection;

      manageConnection.getSessionByConversation.mockResolvedValue({ connectionId: "conn-1" });
      manageConnection.getConnection.mockResolvedValue({ externalId: "chat-123" });

      await broadcaster.broadcast(mockMessage({ source: "feishu" }));

      expect(feishuGateway.replyText).not.toHaveBeenCalled();
    });
  });
});
