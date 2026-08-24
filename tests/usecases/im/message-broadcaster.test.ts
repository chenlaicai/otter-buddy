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

  // broadcast 逐通道 catch 隔离测试
  describe("broadcast 通道错误隔离", () => {
    it("单通道抛错不阻塞后续通道", async () => {
      const { broadcaster, logger } = createBroadcaster();
      
      const received2: Message[] = [];
      
      // 注册两个出站通道
      const channel1 = {
        onMessage: vi.fn().mockRejectedValue(new Error("channel 1 failed")),
        onEvent: vi.fn(),
      };
      const channel2 = {
        onMessage: vi.fn().mockImplementation(async (msg: Message) => { received2.push(msg); }),
        onEvent: vi.fn(),
      };
      
      broadcaster.registerOutboundChannel(channel1);
      broadcaster.registerOutboundChannel(channel2);
      
      const msg = mockMessage();
      await broadcaster.broadcast(msg);
      
      // 通道 2 仍然被调用（不被通道 1 的错误阻塞）
      expect(received2).toHaveLength(1);
      expect(received2[0].id).toBe("msg-1");
      // 错误被记录到日志
      expect(logger.error).toHaveBeenCalled();
    });

    it("多个通道都抛错时全部记录", async () => {
      const { broadcaster, logger } = createBroadcaster();
      
      const channel1 = {
        onMessage: vi.fn().mockRejectedValue(new Error("channel 1 failed")),
        onEvent: vi.fn(),
      };
      const channel2 = {
        onMessage: vi.fn().mockRejectedValue(new Error("channel 2 failed")),
        onEvent: vi.fn(),
      };
      
      broadcaster.registerOutboundChannel(channel1);
      broadcaster.registerOutboundChannel(channel2);
      
      await broadcaster.broadcast(mockMessage());
      
      // 两个错误都被记录
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // #241: 幂等性去重测试
  describe("broadcast 幂等性", () => {
    it("同一 messageId 重复 broadcast 只投递一次", async () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      const msg = mockMessage({ id: "msg-dedup-1" });
      await broadcaster.broadcast(msg);
      await broadcaster.broadcast(msg);
      await broadcaster.broadcast(msg);

      // 只收到 1 次（去重）
      expect(received).toHaveLength(1);
    });

    it("不同 messageId 正常投递", async () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      broadcaster.subscribe("conv-1", (msg) => { received.push(msg); });

      await broadcaster.broadcast(mockMessage({ id: "msg-a" }));
      await broadcaster.broadcast(mockMessage({ id: "msg-b" }));
      await broadcaster.broadcast(mockMessage({ id: "msg-c" }));

      expect(received).toHaveLength(3);
    });
  });
});
