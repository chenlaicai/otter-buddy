import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, readSSEEvents, createMockDeps, makeMessage, makeOtter } from "./helpers";
import type { TestDeps } from "./helpers";

// eslint-disable-next-line max-lines-per-function -- HTTP 契约用例集，单 describe 聚合
describe("Message API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/conversations/:id/messages ───

  describe("GET /api/conversations/:id/messages", () => {
    it("returns messages with default limit", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([
        makeMessage({ id: "msg-1", sequenceNum: 1 }),
        makeMessage({ id: "msg-2", sequenceNum: 2 }),
      ]);

      const res = await app.request("/api/conversations/conv-1/messages");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].id).toBe("msg-1");
      expect(body.messages[0].st).toBe("user");
      expect(body.messages[0].content).toBe("Hello world");
      expect(body.hasMore).toBe(false);
      expect(deps.queryMessage.getMessages).toHaveBeenCalledWith("conv-1", {
        limit: 50,
        before: undefined,
      });
    });

    it("respects custom limit and before params", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=10&before=msg-5");
      expect(res.status).toBe(200);
      expect(deps.queryMessage.getMessages).toHaveBeenCalledWith("conv-1", {
        limit: 10,
        before: "msg-5",
      });
    });

    it("falls back to 50 for invalid limit", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=abc");
      expect(res.status).toBe(200);
      expect(deps.queryMessage.getMessages).toHaveBeenCalledWith("conv-1", {
        limit: 50,
        before: undefined,
      });
    });

    it("falls back to 50 for negative limit", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=-5");
      expect(res.status).toBe(200);
      expect(deps.queryMessage.getMessages).toHaveBeenCalledWith("conv-1", {
        limit: 50,
        before: undefined,
      });
    });
  });

  // ─── POST /api/conversations/:id/messages ───

  describe("POST /api/conversations/:id/messages", () => {
    const validBody = {
      senderId: "user-1",
      talkingStonePassedTo: ["otter-1"],
      body: "Hello otter",
    };

    it("accepts empty talkingStonePassedTo and dispatches to resolved target", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user", talkingStonePassedTo: ["otter-1"] });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      deps.agentInvoker.invokeConversation.mockResolvedValue({ messageId: "agent-msg-1", duration: 100 });

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, talkingStonePassedTo: [] }),
      });

      expect(res.status).toBe(200);
      expect(deps.sendMessageUseCase.send).toHaveBeenCalledWith({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "Hello otter",
      });
      /** 钉住关键行为：首轮派发以持久化消息的解析结果为准，而不是请求体的空数组 */
      await readSSEEvents(res);
      expect(deps.agentInvoker.invokeConversation).toHaveBeenCalledWith(
        expect.objectContaining({ otterId: "otter-1" }),
      );
    });

    it("treats missing talkingStonePassedTo as empty and forwards to usecase", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user", talkingStonePassedTo: ["otter-1"] });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      deps.agentInvoker.invokeConversation.mockResolvedValue({ messageId: "agent-msg-1", duration: 100 });

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: "user-1", body: "Hello" }),
      });

      expect(res.status).toBe(200);
      expect(deps.sendMessageUseCase.send).toHaveBeenCalledWith({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "Hello",
      });
    });

    it("returns 400 when senderId is missing", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ talkingStonePassedTo: ["otter-1"], body: "Hello" }),
      });

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("senderId");
    });

    it("returns 400 when body is missing", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-1"] }),
      });

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("body");
    });

    it("streams SSE events with correct content on success", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user" });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      // 通过 broadcaster 推送事件（统一架构）
      const broadcaster = (app as any).__mockBroadcaster;
      deps.agentInvoker.invokeConversation.mockImplementation(async () => {
        broadcaster.broadcastEvent("conv-1", { event: "message.start", data: { messageId: "agent-msg-1", otterId: "otter-1", otterName: "TestOtter", createdAt: "2026-07-29T00:00:00.000Z" } });
        broadcaster.broadcastEvent("conv-1", { event: "message.delta", data: { text: "Hello" } });
        broadcaster.broadcastEvent("conv-1", { event: "message.complete", data: { messageId: "agent-msg-1", duration: "1.2s" } });
        return { messageId: "agent-msg-1", duration: 1200 };
      });

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await readSSEEvents(res);
      expect(events).toHaveLength(4);
      expect(events[0]).toEqual({ event: "message.start", data: { messageId: "agent-msg-1", otterId: "otter-1", otterName: "TestOtter", createdAt: "2026-07-29T00:00:00.000Z" } });
      expect(events[1]).toEqual({ event: "message.delta", data: { text: "Hello" } });
      expect(events[2]).toEqual({ event: "message.complete", data: { messageId: "agent-msg-1", duration: "1.2s" } });
      expect(events[3]).toEqual({ event: "stream.end", data: {} });

      expect(deps.sendMessageUseCase.send).toHaveBeenCalledWith({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: ["otter-1"],
        body: "Hello otter",
      });
    });

    it("streams error event when agent invocation fails", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user" });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      // 通过 broadcaster 推送错误事件
      const broadcaster = (app as any).__mockBroadcaster;
      deps.agentInvoker.invokeConversation.mockImplementation(async () => {
        broadcaster.broadcastEvent("conv-1", { event: "error", data: { message: "LLM rate limited" } });
        return { messageId: "agent-msg-1", duration: 100 };
      });

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);

      const events = await readSSEEvents(res);
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("error");
      expect(events[0].data.message).toBe("LLM rate limited");
      expect(events[1]).toEqual({ event: "stream.end", data: {} });
    });

    it("客户端断开 SSE 不中止 agent：agent 继续跑完且 abort 不被调用（刷新≠停止）", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user" });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      let invocationCompleted = false;
      deps.agentInvoker.invokeConversation.mockImplementation(async (params: any) => {
        params.onSSEEvent?.({ event: "message.start", data: { messageId: "agent-msg-1", otterId: "otter-1", otterName: "TestOtter", createdAt: "2026-07-29T00:00:00.000Z" } });
        await new Promise((r) => setTimeout(r, 50));
        invocationCompleted = true;
        return { messageId: "agent-msg-1", duration: 50 };
      });

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      /** 读到首个事件后模拟刷新页面导致的客户端断开（hono responseReadable.cancel 会触发 stream.onAbort） */
      await reader.read();
      await reader.cancel();

      /** 等待 agent loop 跑完——断开不应中断发言 */
      await new Promise((r) => setTimeout(r, 150));
      expect(deps.agentInvoker.abort).not.toHaveBeenCalled();
      expect(invocationCompleted).toBe(true);
    });
  });

  // ─── GET /api/messages/:id ───

  describe("GET /api/messages/:id", () => {
    it("returns message by id", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(makeMessage());

      const res = await app.request("/api/messages/msg-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("msg-1");
      expect(body.st).toBe("user");
      expect(body.si).toBe("user-1");
    });

    it("returns 404 when not found", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(null);

      const res = await app.request("/api/messages/missing");
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).toContain("not found");
    });

    it("maps message fields correctly", async () => {
      const msg = makeMessage({
        id: "msg-42",
        senderType: "otter",
        senderId: "otter-1",
        body: "I am an otter",
        status: "completed",
        sequenceNum: 5,
        talkingStonePassedTo: ["user-1"],
        contextTokens: 1500,
        contextTokensMax: 4096,
      });
      deps.queryMessage.getMessageById.mockResolvedValue(msg);

      const res = await app.request("/api/messages/msg-42");
      const body = await json(res);
      expect(body.st).toBe("otter");
      expect(body.si).toBe("otter-1");
      expect(body.content).toBe("I am an otter");
      expect(body.status).toBe("completed");
      expect(body.seq).toBe(5);
      expect(body.tsp).toEqual(["user-1"]);
      expect(body.ctx).toBe(1500);
      expect(body.ctxMax).toBe(4096);
    });

    it("maps sn（发送者名称）与 dur（耗时）字段", async () => {
      /** 对抗检视发现：sn/dur 在 dto.test.ts 删除后 A 类覆盖归零，前端展示依赖 sn */
      const msg = makeMessage({
        id: "msg-sn",
        senderType: "otter",
        senderId: "otter-1",
        status: "completed",
        createdAt: "2026-07-22T00:00:00.000Z",
        completedAt: "2026-07-22T00:00:02.500Z",
      });
      deps.queryMessage.getMessageById.mockResolvedValue(msg);
      deps.queryOtter.getById.mockResolvedValue(makeOtter({ id: "otter-1", name: "大獭" }));

      const res = await app.request("/api/messages/msg-sn");
      const body = await json(res);
      expect(body.sn).toBe("大獭");
      expect(body.dur).toBe("2.5s");
    });
  });

  // ─── GET /api/messages/:id/events ───

  describe("GET /api/messages/:id/events", () => {
    it("returns message events", async () => {
      deps.queryMessage.getMessageEvents.mockResolvedValue([
        {
          id: "evt-1",
          messageId: "msg-1",
          eventType: "text_delta",
          payload: { text: "Hello" },
          sequenceNum: 1,
          createdAt: new Date().toISOString(),
        },
      ]);

      const res = await app.request("/api/messages/msg-1/events");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].eventType).toBe("text_delta");
    });
  });

  // ─── POST /api/messages/:id/abort ───

  describe("POST /api/messages/:id/abort", () => {
    it("returns 404 when message not found", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(null);

      const res = await app.request("/api/messages/missing/abort", {
        method: "POST",
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 when message is not otter type", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(
        makeMessage({ senderType: "user" }),
      );

      const res = await app.request("/api/messages/msg-1/abort", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("otter");
    });

    it("aborts otter message and calls agentInvoker.abort", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(
        makeMessage({ senderType: "otter", senderId: "otter-1", status: "streaming" }),
      );

      const res = await app.request("/api/messages/msg-1/abort", {
        method: "POST",
      });

      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body.status).toBe("aborted");
      expect(deps.agentInvoker.abort).toHaveBeenCalledWith("otter-1", "msg-1");
    });

    it("returns 409 when message is already in terminal status（防止 stale abortedOtters 标记）", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(
        makeMessage({ senderType: "otter", senderId: "otter-1", status: "completed" }),
      );

      const res = await app.request("/api/messages/msg-1/abort", {
        method: "POST",
      });

      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error).toContain("terminal");
      expect(deps.agentInvoker.abort).not.toHaveBeenCalled();
    });
  });

  // ─── POST /api/messages/:id/retry (#332 链引擎路径) ───

  describe('POST /api/messages/:id/retry', () => {
    it('failed otter 消息重试走 DispatchChainEngine（invokeFn 包装 agentInvoker）', async () => {
      const failedMsg = makeMessage({
        id: 'failed-msg-1',
        conversationId: 'conv-1',
        turnId: 'turn-1',
        senderType: 'otter',
        senderId: 'otter-1',
        status: 'failed',
        body: 'original prompt',
      });
      deps.queryMessage.getMessageById.mockResolvedValue(failedMsg);
      deps.queryMessage.getMessages.mockResolvedValue([
        makeMessage({ senderType: 'user', senderId: 'user-1' }),
      ]);
      deps.agentInvoker.invokeConversation.mockResolvedValue({ messageId: 'retry-msg-1', duration: 100 });

      const res = await app.request('/api/messages/failed-msg-1/retry', { method: 'POST' });

      expect(res.status).toBe(200);
      await readSSEEvents(res);

      // Why: 链引擎通过 invokeFn 调用 agentInvoker，验证 retryCount/manualRetry 正确传递
      expect(deps.agentInvoker.invokeConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          otterId: 'otter-1',
          conversationId: 'conv-1',
          senderId: 'user-1',
          retryCount: 1,
          manualRetry: true,
        }),
      );
    });

    it('非 otter 消息重试返回 400', async () => {
      const userMsg = makeMessage({ id: 'user-msg-1', senderType: 'user', status: 'completed' });
      deps.queryMessage.getMessageById.mockResolvedValue(userMsg);

      const res = await app.request('/api/messages/user-msg-1/retry', { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('非 failed/aborted 消息重试返回 409', async () => {
      const completedMsg = makeMessage({ id: 'completed-msg-1', senderType: 'otter', status: 'completed' });
      deps.queryMessage.getMessageById.mockResolvedValue(completedMsg);

      const res = await app.request('/api/messages/completed-msg-1/retry', { method: 'POST' });
      expect(res.status).toBe(409);
    });

    it('消息不存在返回 404', async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(null);

      const res = await app.request('/api/messages/nonexistent/retry', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });
});

describe("Message API - 未读注入剥离投影（F20260728htar）", () => {
  it("html-card 替换为占位符、html-card-reply 保留 JSON", async () => {
    const deps = createMockDeps();
    const app = createTestApp(deps);
    const userMsg = makeMessage({ id: "user-msg-1", senderType: "user", talkingStonePassedTo: ["otter-1"] });
    deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
    deps.conversationRepo.getUnreadMessages.mockResolvedValue([
      makeMessage({
        id: "otter-msg-1", senderType: "otter", senderId: "otter-1",
        body: '看卡片\n```html-card title="方案对比"\n<table><tr><td>噪声</td></tr></table>\n```\n完',
      }),
      makeMessage({
        id: "user-msg-0", senderType: "user", senderId: "user-1", sequenceNum: 0,
        body: '选择了方案 B\n```html-card-reply card="otter-msg-1:0"\n{"choice":"B"}\n```',
      }),
    ]);
    let invokedContent = "";
    deps.agentInvoker.invokeConversation.mockImplementation(async (params: any) => {
      invokedContent = params.userMessageContent;
      return { messageId: "agent-msg-1", duration: 100 };
    });

    const res = await app.request("/api/conversations/conv-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-1"], body: "Hello otter" }),
    });
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    /** 卡片剥离为占位符（不含 HTML 噪声）；回执 JSON 原样保留（水獭直接可解析） */
    expect(invokedContent).toContain("[html-card: 方案对比]");
    expect(invokedContent).not.toContain("<table>");
    expect(invokedContent).toContain('```html-card-reply card="otter-msg-1:0"');
    expect(invokedContent).toContain('{"choice":"B"}');
  });
});
