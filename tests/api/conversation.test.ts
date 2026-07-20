import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps, makeConversation, makeParticipant } from "./helpers";
import type { TestDeps } from "./helpers";
import { DomainError } from "../../src/entities/errors";

describe("Conversation API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/conversations ───

  describe("GET /api/conversations", () => {
    it("returns 400 when otterId is missing", async () => {
      const res = await app.request("/api/conversations");
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("otterId");
    });

    it("returns conversation list with otterIds", async () => {
      deps.manageConversation.getIdsByOtterId.mockResolvedValue(["conv-1"]);
      deps.manageConversation.getById.mockResolvedValue(makeConversation());
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([
        makeParticipant({ otterId: "otter-1" }),
      ]);

      const res = await app.request("/api/conversations?otterId=otter-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("conv-1");
      expect(body[0].otterIds).toEqual(["otter-1"]);
    });

    it("filters out null entries when conversation not found", async () => {
      deps.manageConversation.getIdsByOtterId.mockResolvedValue(["conv-missing"]);
      deps.manageConversation.getById.mockResolvedValue(null);

      const res = await app.request("/api/conversations?otterId=otter-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(0);
    });

    it("returns empty array when no conversations", async () => {
      deps.manageConversation.getIdsByOtterId.mockResolvedValue([]);

      const res = await app.request("/api/conversations?otterId=otter-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual([]);
    });
  });

  // ─── POST /api/conversations ───

  describe("POST /api/conversations", () => {
    it("creates a conversation and returns 201", async () => {
      const conv = makeConversation({ id: "new-conv", title: "New Chat" });
      deps.manageConversation.create.mockResolvedValue(conv);

      const res = await app.request("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat", otterIds: ["otter-1"] }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-conv");
      expect(body.title).toBe("New Chat");
      expect(deps.manageConversation.create).toHaveBeenCalledWith({
        title: "New Chat",
        otterIds: ["otter-1"],
      });
    });

    it("creates conversation without otterIds", async () => {
      const conv = makeConversation({ id: "new-conv" });
      deps.manageConversation.create.mockResolvedValue(conv);

      const res = await app.request("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Solo Chat" }),
      });

      expect(res.status).toBe(201);
      expect(deps.manageConversation.create).toHaveBeenCalledWith({
        title: "Solo Chat",
        otterIds: undefined,
      });
    });
  });

  // ─── GET /api/conversations/:id ───

  describe("GET /api/conversations/:id", () => {
    it("returns conversation by id", async () => {
      deps.manageConversation.getById.mockResolvedValue(makeConversation());

      const res = await app.request("/api/conversations/conv-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("conv-1");
    });

    it("returns 404 when not found", async () => {
      deps.manageConversation.getById.mockResolvedValue(null);

      const res = await app.request("/api/conversations/missing");
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).toContain("not found");
    });
  });

  // ─── PATCH /api/conversations/:id/complete ───

  describe("PATCH /api/conversations/:id/complete", () => {
    it("completes conversation", async () => {
      deps.manageConversation.complete.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/complete", {
        method: "PATCH",
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("completed");
      expect(deps.manageConversation.complete).toHaveBeenCalledWith("conv-1");
    });

    it("returns 404 when conversation not found", async () => {
      deps.manageConversation.complete.mockRejectedValue(
        new DomainError("Conversation not found: missing", "not_found"),
      );

      const res = await app.request("/api/conversations/missing/complete", {
        method: "PATCH",
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 when conversation cannot be completed", async () => {
      deps.manageConversation.complete.mockRejectedValue(
        new DomainError("Cannot complete conversation with status: completed", "validation"),
      );

      const res = await app.request("/api/conversations/conv-1/complete", {
        method: "PATCH",
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── PATCH /api/conversations/:id/archive ───

  describe("PATCH /api/conversations/:id/archive", () => {
    it("archives conversation", async () => {
      deps.manageConversation.archive.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/archive", {
        method: "PATCH",
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("archived");
      expect(deps.manageConversation.archive).toHaveBeenCalledWith("conv-1");
    });

    it("returns 400 when cannot archive (not completed)", async () => {
      deps.manageConversation.archive.mockRejectedValue(
        new DomainError("Cannot archive conversation with status: active", "validation"),
      );

      const res = await app.request("/api/conversations/conv-1/archive", {
        method: "PATCH",
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/conversations/:id/participants ───

  describe("GET /api/conversations/:id/participants", () => {
    it("returns participants list", async () => {
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([
        makeParticipant({ otterId: "otter-1" }),
        makeParticipant({ id: "part-2", otterId: "otter-2" }),
      ]);

      const res = await app.request("/api/conversations/conv-1/participants");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].otterId).toBe("otter-1");
      expect(body[1].otterId).toBe("otter-2");
    });

    it("returns empty array when no participants", async () => {
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/participants");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual([]);
    });
  });
});
