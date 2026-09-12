import { describe, it, expect, vi } from "vitest";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";

/** F20260910ctlv 处置轮重写：消息级面（subscribe 三参/broadcast/broadcastToWeb）已删，
 *  事件级面（subscribeEvents/broadcastEvent）是唯一通道。 */

function createBroadcaster() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  const broadcaster = new MessageBroadcaster(logger);
  return { broadcaster, logger };
}

describe("MessageBroadcaster（事件总线）", () => {
  describe("subscribeEvents + broadcastEvent", () => {
    it("broadcastEvent 调用订阅回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: string[] = [];
      broadcaster.subscribeEvents("conv-1", (e) => { received.push(e.event); });

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      expect(received).toEqual(["invoke.start"]);
    });

    it("broadcastEvent 不调用不同 conversation 的回调", () => {
      const { broadcaster } = createBroadcaster();
      const received: string[] = [];
      broadcaster.subscribeEvents("conv-1", (e) => { received.push(e.event); });

      broadcaster.broadcastEvent("conv-2", { event: "invoke.start", data: {} });

      expect(received).toHaveLength(0);
    });

    it("取消订阅后不再收到事件", () => {
      const { broadcaster } = createBroadcaster();
      const received: string[] = [];
      const unsubscribe = broadcaster.subscribeEvents("conv-1", (e) => { received.push(e.event); });

      unsubscribe();
      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      expect(received).toHaveLength(0);
    });
  });

  describe("broadcastEvent 通道错误隔离", () => {
    it("单通道抛错不阻塞后续通道与 Web 订阅", () => {
      const { broadcaster } = createBroadcaster();
      // 副作用断言（no-restricted-syntax：禁调用次数断言）
      const badEvents: string[] = [];
      const goodEvents: string[] = [];
      const bad = { onEvent: vi.fn(() => { badEvents.push("hit"); throw new Error("boom"); }) };
      const good = { onEvent: vi.fn((_cid: string, e: { event: string }) => { goodEvents.push(e.event); }) };
      broadcaster.registerOutboundChannel("bad", bad as never);
      broadcaster.registerOutboundChannel("good", good as never);
      const received: string[] = [];
      broadcaster.subscribeEvents("conv-1", (e) => { received.push(e.event); });

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      expect(badEvents).toEqual(["hit"]);
      expect(goodEvents).toEqual(["invoke.start"]);
      expect(received).toEqual(["invoke.start"]);
    });
  });

  // #591：键控注册语义——同 key 替换、unregister 清理（副作用数组断言，非调用次数）
  describe("出站通道键控注册（#591）", () => {
    it("同 key 重复注册替换旧通道：一个事件只投递给新通道一次", () => {
      const { broadcaster } = createBroadcaster();
      const oldEvents: string[] = [];
      const newEvents: string[] = [];
      const oldChannel = { onEvent: vi.fn((_cid: string, e: { event: string }) => { oldEvents.push(e.event); }) };
      const newChannel = { onEvent: vi.fn((_cid: string, e: { event: string }) => { newEvents.push(e.event); }) };

      broadcaster.registerOutboundChannel("weixin-acc1", oldChannel as never);
      broadcaster.registerOutboundChannel("weixin-acc1", newChannel as never);

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      // 旧通道不再收，新通道收一次——重复登录不再重复投递
      expect(oldEvents).toHaveLength(0);
      expect(newEvents).toEqual(["invoke.start"]);
    });

    it("同 key 替换保插入序：先注册的通道仍先收到事件", () => {
      const { broadcaster } = createBroadcaster();
      const order: string[] = [];
      const feishu = { onEvent: vi.fn(() => order.push("feishu")) };
      const weixinOld = { onEvent: vi.fn(() => order.push("weixin-old")) };
      const weixinNew = { onEvent: vi.fn(() => order.push("weixin-new")) };

      broadcaster.registerOutboundChannel("feishu", feishu as never);
      broadcaster.registerOutboundChannel("weixin-acc1", weixinOld as never);
      broadcaster.registerOutboundChannel("weixin-acc1", weixinNew as never);

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      // Map 替换不改变插入位置：feishu 先于 weixin，且只有 weixin-new 收到
      expect(order).toEqual(["feishu", "weixin-new"]);
    });

    it("unregister 后通道不再收到投递；未注册 key 返回 false", () => {
      const { broadcaster } = createBroadcaster();
      const events: string[] = [];
      const channel = { onEvent: vi.fn((_cid: string, e: { event: string }) => { events.push(e.event); }) };

      broadcaster.registerOutboundChannel("weixin-acc1", channel as never);
      expect(broadcaster.unregisterOutboundChannel("weixin-acc1")).toBe(true);
      expect(broadcaster.unregisterOutboundChannel("weixin-acc1")).toBe(false);

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      expect(events).toHaveLength(0);
    });

    it("不同 key 互不影响：两个微信账号各投一次", () => {
      const { broadcaster } = createBroadcaster();
      const acc1Events: string[] = [];
      const acc2Events: string[] = [];
      const acc1 = { onEvent: vi.fn((_cid: string, e: { event: string }) => { acc1Events.push(e.event); }) };
      const acc2 = { onEvent: vi.fn((_cid: string, e: { event: string }) => { acc2Events.push(e.event); }) };

      broadcaster.registerOutboundChannel("weixin-acc1", acc1 as never);
      broadcaster.registerOutboundChannel("weixin-acc2", acc2 as never);

      broadcaster.broadcastEvent("conv-1", { event: "invoke.start", data: {} });

      expect(acc1Events).toHaveLength(1);
      expect(acc2Events).toHaveLength(1);
    });
  });
});
