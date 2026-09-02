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
      
      broadcaster.registerOutboundChannel("ch-1", channel1);
      broadcaster.registerOutboundChannel("ch-2", channel2);
      
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
      
      broadcaster.registerOutboundChannel("ch-1", channel1);
      broadcaster.registerOutboundChannel("ch-2", channel2);
      
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

  // #591：键控注册语义——同 key 替换、unregister 清理（副作用数组断言，非调用次数）
  describe("出站通道键控注册（#591）", () => {
    it("同 key 重复注册替换旧通道：一条消息只投递给新通道一次", async () => {
      const { broadcaster } = createBroadcaster();
      const oldReceived: Message[] = [];
      const newReceived: Message[] = [];
      const oldChannel = { onMessage: vi.fn(async (m: Message) => { oldReceived.push(m); }), onEvent: vi.fn() };
      const newChannel = { onMessage: vi.fn(async (m: Message) => { newReceived.push(m); }), onEvent: vi.fn() };

      broadcaster.registerOutboundChannel("weixin-acc1", oldChannel);
      broadcaster.registerOutboundChannel("weixin-acc1", newChannel);

      await broadcaster.broadcast(mockMessage());

      // 旧通道不再收，新通道收一次——重复登录不再重复投递
      expect(oldReceived).toHaveLength(0);
      expect(newReceived).toHaveLength(1);
      expect(newReceived[0].id).toBe("msg-1");
    });

    it("同 key 替换保插入序：先注册的通道仍先收到事件", () => {
      const { broadcaster } = createBroadcaster();
      const order: string[] = [];
      const feishu = { onMessage: vi.fn(), onEvent: vi.fn(() => order.push("feishu")) };
      const weixinOld = { onMessage: vi.fn(), onEvent: vi.fn(() => order.push("weixin-old")) };
      const weixinNew = { onMessage: vi.fn(), onEvent: vi.fn(() => order.push("weixin-new")) };

      broadcaster.registerOutboundChannel("feishu", feishu);
      broadcaster.registerOutboundChannel("weixin-acc1", weixinOld);
      broadcaster.registerOutboundChannel("weixin-acc1", weixinNew);

      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      // Map 替换不改变插入位置：feishu 先于 weixin，且只有 weixin-new 收到
      expect(order).toEqual(["feishu", "weixin-new"]);
    });

    it("unregister 后通道不再收到投递；未注册 key 返回 false", async () => {
      const { broadcaster } = createBroadcaster();
      const received: Message[] = [];
      const events: string[] = [];
      const channel = {
        onMessage: vi.fn(async (m: Message) => { received.push(m); }),
        onEvent: vi.fn((_cid: string, e: { event: string }) => { events.push(e.event); }),
      };

      broadcaster.registerOutboundChannel("weixin-acc1", channel);
      expect(broadcaster.unregisterOutboundChannel("weixin-acc1")).toBe(true);
      expect(broadcaster.unregisterOutboundChannel("weixin-acc1")).toBe(false);

      await broadcaster.broadcast(mockMessage());
      broadcaster.broadcastEvent("conv-1", { event: "message.start", data: {} });

      expect(received).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it("不同 key 互不影响：两个微信账号各投一次", async () => {
      const { broadcaster } = createBroadcaster();
      const acc1Received: Message[] = [];
      const acc2Received: Message[] = [];
      const acc1 = { onMessage: vi.fn(async (m: Message) => { acc1Received.push(m); }), onEvent: vi.fn() };
      const acc2 = { onMessage: vi.fn(async (m: Message) => { acc2Received.push(m); }), onEvent: vi.fn() };

      broadcaster.registerOutboundChannel("weixin-acc1", acc1);
      broadcaster.registerOutboundChannel("weixin-acc2", acc2);

      await broadcaster.broadcast(mockMessage());

      expect(acc1Received).toHaveLength(1);
      expect(acc2Received).toHaveLength(1);
    });
  });
});
