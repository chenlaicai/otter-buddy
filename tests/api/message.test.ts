import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, createMockDeps, makeMessage } from "./helpers";
import type { TestDeps } from "./helpers";

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
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("msg-1");
      expect(body[0].st).toBe("user");
      expect(body[0].content).toBe("Hello world");
    });

    it("respects custom limit and before params", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=10&before=msg-5");
      expect(res.status).toBe(200);
    });

    it("falls back to 50 for invalid limit", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=abc");
      expect(res.status).toBe(200);
    });

    it("falls back to 50 for negative limit", async () => {
      deps.queryMessage.getMessages.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/messages?limit=-5");
      expect(res.status).toBe(200);
    });
  });

  // ─── POST /api/conversations/:id/messages ───

  describe("POST /api/conversations/:id/messages", () => {
    const validBody = {
      senderId: "user-1",
      talkingStonePassedTo: ["otter-1"],
      body: "Hello otter",
    };

    it("returns 400 when talkingStonePassedTo is empty", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, talkingStonePassedTo: [] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("talkingStonePassedTo");
    });

    it("returns 400 when talkingStonePassedTo is missing", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: "user-1", body: "Hello" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when senderId is missing", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ talkingStonePassedTo: ["otter-1"], body: "Hello" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("senderId");
    });

    it("returns 400 when body is missing", async () => {
      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-1"] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("body");
    });

    it("creates user message and returns SSE stream", async () => {
      const userMsg = makeMessage({ id: "user-msg-1", senderType: "user" });
      deps.sendMessageUseCase.send.mockResolvedValue(userMsg);
      // agentInvoker.invokeConversation is fire-and-forget, mock it to return a never-resolving promise
      deps.agentInvoker.invokeConversation.mockReturnValue(new Promise(() => {}));

      const res = await app.request("/api/conversations/conv-1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

      // SSE response
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });

  // ─── GET /api/messages/:id ───

  describe("GET /api/messages/:id", () => {
    it("returns message by id", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(makeMessage());

      const res = await app.request("/api/messages/msg-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("msg-1");
      expect(body.st).toBe("user");
      expect(body.si).toBe("user-1");
    });

    it("returns 404 when not found", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(null);

      const res = await app.request("/api/messages/missing");
      expect(res.status).toBe(404);
      const body = await res.json();
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
      const body = await res.json();
      expect(body.st).toBe("otter");
      expect(body.si).toBe("otter-1");
      expect(body.content).toBe("I am an otter");
      expect(body.seq).toBe(5);
      expect(body.tsp).toEqual(["user-1"]);
      expect(body.ctx).toBe(1500);
      expect(body.ctxMax).toBe(4096);
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
      const body = await res.json();
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
      const body = await res.json();
      expect(body.error).toContain("otter");
    });

    it("aborts otter message successfully", async () => {
      deps.queryMessage.getMessageById.mockResolvedValue(
        makeMessage({ senderType: "otter", senderId: "otter-1" }),
      );

      const res = await app.request("/api/messages/msg-1/abort", {
        method: "POST",
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("aborted");
    });
  });
});
