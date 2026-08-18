import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { Message } from "@entities/conversation/message";

function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1",
    talkingStonePassedTo: null, status: "completed",
    segments: [{ id: "seg-1", messageId: "msg-1", body: "hello", sequenceNum: 0, createdAt: "2026-07-31T00:00:00Z" }],
    sequenceNum: 1,
    contextTokens: null, contextTokensMax: null,
    source: "web",
    createdAt: "2026-07-31T00:00:00Z", completedAt: "2026-07-31T00:00:01Z",
    ...overrides,
  };
}

function createTestApp(broadcaster: MessageBroadcaster) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const queryOtter = { getById: vi.fn().mockResolvedValue({ id: "otter-1", name: "大獭", type: "big" }) };
  const ctrl = new MessageController(
    {} as SendMessage, {} as QueryMessage, { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState, {} as AgentInvoker,
    logger as any, queryOtter as unknown as QueryOtter, {} as DispatchChainEngine, broadcaster,
  );
  const app = new Hono();
  app.get("/api/conversations/:id/subscribe", (c) => ctrl.subscribe(c));
  return app;
}

/** 从 SSE 响应中读取所有事件（带超时） */
async function readSSEEvents(res: Response, timeoutMs = 500): Promise<Array<{ event: string; data: string }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>(r => setTimeout(() => r({ done: true, value: undefined }), timeoutMs)),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        currentData = line.slice(6);
      } else if (line === "" && currentEvent) {
        events.push({ event: currentEvent, data: currentData });
        currentEvent = "";
        currentData = "";
      }
    }
  }

  reader.cancel().catch(() => {});
  return events;
}

describe("Subscribe SSE streaming events", () => {
  /** issue #281：以下用例的裸总线（无出站通道）即 web-only 部署形态——
   *  修复前 web-only 装配中 broadcaster 为 undefined，subscribe 返回 500、POST 流无事件 */
  it("broadcastEvent 推送的事件以正确的 event type 到达 SSE 流", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const broadcaster = new MessageBroadcaster(logger); // issue #281：纯总线

    const app = createTestApp(broadcaster);

    // 发起 SSE 订阅（非阻塞）
    const resPromise = app.request("/api/conversations/conv-1/subscribe");

    // 等待订阅建立
    await new Promise(r => setTimeout(r, 50));

    // 广播 streaming 事件
    broadcaster.broadcastEvent("conv-1", { event: "message.start", data: { messageId: "msg-1", otterId: "otter-1", otterName: "大獭" } });
    broadcaster.broadcastEvent("conv-1", { event: "message.complete", data: { messageId: "msg-1", body: "hello" } });

    // 读取 SSE 事件
    const res = await resPromise;
    const events = await readSSEEvents(res, 1000);

    // 验证事件类型和数据
    const startEvent = events.find(e => e.event === "message.start");
    expect(startEvent).toBeDefined();
    expect(JSON.parse(startEvent!.data)).toMatchObject({ messageId: "msg-1", otterId: "otter-1", otterName: "大獭" });

    const completeEvent = events.find(e => e.event === "message.complete");
    expect(completeEvent).toBeDefined();
    expect(JSON.parse(completeEvent!.data)).toMatchObject({ messageId: "msg-1", body: "hello" });
  });

  it("broadcast 推送的 message 事件以 event:message 到达 SSE 流", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const broadcaster = new MessageBroadcaster(logger); // issue #281：纯总线

    const app = createTestApp(broadcaster);

    const resPromise = app.request("/api/conversations/conv-1/subscribe");
    await new Promise(r => setTimeout(r, 50));

    // 广播已完成消息
    broadcaster.broadcast(mockMessage());

    const res = await resPromise;
    const events = await readSSEEvents(res, 1000);

    const msgEvent = events.find(e => e.event === "message");
    expect(msgEvent).toBeDefined();
    const data = JSON.parse(msgEvent!.data);
    expect(data.id).toBe("msg-1");
    expect(data.st).toBe("otter");
  });
});
