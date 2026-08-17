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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  /** issue #281：纯总线（无出站通道），Web 订阅语义测试 */
  const broadcaster = new MessageBroadcaster(logger);
  return { broadcaster, logger };
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
});
