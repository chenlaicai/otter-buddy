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
    it("returns conversation list", async () => {
      deps.manageConversation.listWithMeta.mockResolvedValue([
        { ...makeConversation(), otterIds: ["otter-1"], unreadCount: 0, lastMessagePreview: null, lastMessageTs: null },
      ]);

      const res = await app.request("/api/conversations");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("conv-1");
      expect(body[0].otterIds).toEqual(["otter-1"]);
    });

    it("activityStatus 在 HTTP 响应中正确透传（F20260805actv：防字段在边界脱落）", async () => {
      deps.manageConversation.listWithMeta.mockResolvedValue([
        { ...makeConversation(), otterIds: ["otter-1"], unreadCount: 2, lastMessagePreview: "预览", lastMessageTs: "2026-07-16T00:01:00Z", activityStatus: "processing" },
      ]);

      const res = await app.request("/api/conversations");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(1);
      expect(body[0].activityStatus).toBe("processing");
      expect(body[0].unreadCount).toBe(2);
      expect(body[0].lastMessagePreview).toBe("预览");
    });

    it("returns empty list when listWithMeta returns empty", async () => {
      deps.manageConversation.listWithMeta.mockResolvedValue([]);

      const res = await app.request("/api/conversations");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(0);
    });

    it("returns 400 for invalid pagination parameters", async () => {
      const res = await app.request("/api/conversations?limit=abc");
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Invalid pagination parameters");
    });
  });

  // ─── POST /api/conversations ───

  describe("POST /api/conversations", () => {
    it("creates a conversation and returns 201", async () => {
      const conv = makeConversation({ id: "new-conv", title: "New Chat" });
      deps.manageConversation.create.mockResolvedValue(conv);
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([
        { participant: makeParticipant({ otterId: "otter-1" }), otterName: "大獭" },
      ]);

      const res = await app.request("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat" }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-conv");
      expect(body.title).toBe("New Chat");
      expect(deps.manageConversation.create).toHaveBeenCalledWith({
        title: "New Chat",
      });
    });

    it("passes undefined title when body is empty", async () => {
      const conv = makeConversation({ id: "new-conv" });
      deps.manageConversation.create.mockResolvedValue(conv);
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([
        { participant: makeParticipant({ otterId: "otter-1" }), otterName: "大獭" },
      ]);

      const res = await app.request("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      // Controller does not validate title — passes undefined to use case
      expect(res.status).toBe(201);
      expect(deps.manageConversation.create).toHaveBeenCalledWith({
        title: undefined,
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
        { participant: makeParticipant({ otterId: "otter-1" }), otterName: "Big Otter" },
        { participant: makeParticipant({ id: "part-2", otterId: "otter-2" }), otterName: "Small Otter" },
      ]);

      const res = await app.request("/api/conversations/conv-1/participants");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].otterId).toBe("otter-1");
      expect(body[0].otterName).toBe("Big Otter");
      expect(body[1].otterId).toBe("otter-2");
      expect(body[1].otterName).toBe("Small Otter");
    });

    it("modelAlias 在 HTTP 响应中正确透传，未配置时字段缺省（防字段在边界脱落）", async () => {
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([
        { participant: makeParticipant({ otterId: "otter-1" }), otterName: "Small Otter", otterType: "small", modelAlias: "mimo" },
        { participant: makeParticipant({ id: "part-2", otterId: "otter-2" }), otterName: "Big Otter", otterType: "big" },
      ]);

      const res = await app.request("/api/conversations/conv-1/participants");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].modelAlias).toBe("mimo");
      /** 未配置时不返回该字段（JSON 中不存在 key），前端不渲染占位 */
      expect("modelAlias" in body[1]).toBe(false);
    });

    it("returns empty array when no participants", async () => {
      deps.manageParticipant.getActiveParticipants.mockResolvedValue([]);

      const res = await app.request("/api/conversations/conv-1/participants");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual([]);
    });
  });

  // ─── PATCH /api/conversations/:id/pin|unpin（自 controllers.test.ts 迁入，走真路由） ───
  describe("PATCH pin/unpin", () => {
    it("pin 成功返回 200 和 status=pinned", async () => {
      deps.manageConversation.pin.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/pin", { method: "PATCH" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("pinned");
    });

    it("pin 不存在返回 404", async () => {
      deps.manageConversation.pin.mockRejectedValue(new DomainError("Conversation not found", "not_found"));

      const res = await app.request("/api/conversations/nonexistent/pin", { method: "PATCH" });
      expect(res.status).toBe(404);
    });

    it("unpin 成功返回 200 和 status=unpinned", async () => {
      deps.manageConversation.unpin.mockResolvedValue(undefined);

      const res = await app.request("/api/conversations/conv-1/unpin", { method: "PATCH" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("unpinned");
    });

    it("unpin healing 对话被拒绝返回 403（不调用 usecase）", async () => {
      const healingId = "healing-conv-id";
      deps.settingsRepo.get.mockResolvedValue(healingId);
      deps.manageConversation.unpin.mockResolvedValue(undefined);

      const res = await app.request(`/api/conversations/${healingId}/unpin`, { method: "PATCH" });
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.error).toBe("系统对话不可取消置顶");
      expect(deps.manageConversation.unpin).not.toHaveBeenCalled();
    });

    it("unpin 不存在返回 404", async () => {
      deps.settingsRepo.get.mockResolvedValue(null);
      deps.manageConversation.unpin.mockRejectedValue(new DomainError("Conversation not found", "not_found"));

      const res = await app.request("/api/conversations/nonexistent/unpin", { method: "PATCH" });
      expect(res.status).toBe(404);
    });
  });
});
