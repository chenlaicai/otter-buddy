import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, json, createMockDeps, makeOtter, makeSession } from "./helpers";
import type { TestDeps } from "./helpers";
import { DomainError } from "../../src/entities/errors";

describe("Otter API", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  // ─── GET /api/otters/:id ───

  describe("GET /api/otters/:id", () => {
    it("returns otter by id", async () => {
      deps.queryOtter.getById.mockResolvedValue(makeOtter());

      const res = await app.request("/api/otters/otter-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("otter-1");
    });

    it("returns 404 when not found", async () => {
      deps.queryOtter.getById.mockResolvedValue(null);

      const res = await app.request("/api/otters/missing");
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/otters ───

  describe("POST /api/otters", () => {
    it("creates an otter and returns 201", async () => {
      const otter = makeOtter({ id: "new-otter", name: "New Friend" });
      deps.createOtterUseCase.execute.mockResolvedValue(otter);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Friend", type: "small" }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-otter");
      expect(body.name).toBe("New Friend");
      expect(deps.createOtterUseCase.execute).toHaveBeenCalledWith({
        name: "New Friend",
        type: "small",
        role: undefined,
        parentOtterId: undefined,
        systemPrompt: undefined,
        context: undefined,
      });
    });

    it("passes all optional fields", async () => {
      const otter = makeOtter();
      deps.createOtterUseCase.execute.mockResolvedValue(otter);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Child Otter",
          type: "small",
          role: { name: "coder", responsibilities: ["write code"] },
          parentOtterId: "parent-1",
          systemPrompt: "You are a coder",
          context: { project: "test" },
        }),
      });

      expect(res.status).toBe(201);
      expect(deps.createOtterUseCase.execute).toHaveBeenCalledWith({
        name: "Child Otter",
        type: "small",
        role: { name: "coder", responsibilities: ["write code"] },
        parentOtterId: "parent-1",
        systemPrompt: "You are a coder",
        context: { project: "test" },
      });
    });

    it("passes undefined fields when body is empty", async () => {
      const otter = makeOtter();
      deps.createOtterUseCase.execute.mockResolvedValue(otter);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      // Controller does not validate name/type — passes undefined to use case
      expect(res.status).toBe(201);
      expect(deps.createOtterUseCase.execute).toHaveBeenCalledWith({
        name: undefined,
        type: undefined,
        role: undefined,
        parentOtterId: undefined,
        systemPrompt: undefined,
        context: undefined,
      });
    });
  });

  // ─── DELETE /api/otters/:id ───

  describe("DELETE /api/otters/:id", () => {
    it("dissolves an otter", async () => {
      deps.dissolveOtterUseCase.execute.mockResolvedValue(undefined);

      const res = await app.request("/api/otters/otter-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.status).toBe("dissolved");
    });

    it("passes summary from body", async () => {
      deps.dissolveOtterUseCase.execute.mockResolvedValue(undefined);

      const res = await app.request("/api/otters/otter-1", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Done with work" }),
      });

      expect(res.status).toBe(200);
      expect(deps.dissolveOtterUseCase.execute).toHaveBeenCalledWith("otter-1", "Done with work");
    });

    it("returns error when dissolve fails", async () => {
      deps.dissolveOtterUseCase.execute.mockRejectedValue(
        new DomainError("Otter not found: missing", "not_found"),
      );

      const res = await app.request("/api/otters/missing", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/otters/:id/sessions ───

  describe("GET /api/otters/:id/sessions", () => {
    it("returns session history", async () => {
      deps.manageSession.getSessionHistory.mockResolvedValue([
        makeSession({ id: "s1", status: "archived" }),
        makeSession({ id: "s2", status: "active" }),
      ]);

      const res = await app.request("/api/otters/otter-1/sessions");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("s1");
      expect(body[1].id).toBe("s2");
    });

    it("returns empty array when no sessions", async () => {
      deps.manageSession.getSessionHistory.mockResolvedValue([]);

      const res = await app.request("/api/otters/otter-1/sessions");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual([]);
    });
  });

  // ─── POST /api/otters/:id/restart ───

  describe("POST /api/otters/:id/restart", () => {
    it("archives active session and creates new one", async () => {
      const activeSession = makeSession({ id: "old-session" });
      const newSession = makeSession({ id: "new-session" });
      deps.manageSession.getActiveSession.mockResolvedValue(activeSession);
      deps.manageSession.archiveSession.mockResolvedValue(activeSession);
      deps.manageSession.createSession.mockResolvedValue(newSession);

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Restarting" }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-session");
      expect(deps.manageSession.archiveSession).toHaveBeenCalledWith("old-session", {
        reason: "restart",
        isNegativeCase: false,
        summary: "Restarting",
      });
      expect(deps.manageSession.createSession).toHaveBeenCalledWith("otter-1", { summary: "Restarting" });
      /** 顺序 load-bearing：archive 必须先于 createSession，否则 createSession 撞 active 必 409 */
      expect(
        deps.manageSession.archiveSession.mock.invocationCallOrder[0],
      ).toBeLessThan(deps.manageSession.createSession.mock.invocationCallOrder[0]);
    });

    it("F20260805rsto 竞态认领：createSession 撞 conflict 时认领兜底新行、补写 summary、按成功返回", async () => {
      const activeSession = makeSession({ id: "old-session" });
      const adopted = makeSession({ id: "backfilled-session" });
      deps.manageSession.getActiveSession
        .mockResolvedValueOnce(activeSession)  // restart 入口查到旧 active
        .mockResolvedValueOnce(adopted);       // conflict 后重读到兜底新行
      deps.manageSession.archiveSession.mockResolvedValue(activeSession);
      deps.manageSession.createSession.mockRejectedValue(
        new DomainError("Otter otter-1 already has an active session: backfilled-session", "conflict"),
      );

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "前情" }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("backfilled-session");
      expect(deps.manageSession.setSessionSummary).toHaveBeenCalledWith("backfilled-session", "前情");
    });

    it("F20260805rsto：小獭不支持重启（重启是大獭专属，小獭用解散），返回 400", async () => {
      deps.queryOtter.getById.mockResolvedValue(makeOtter({ type: "small" }));

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      expect(deps.manageSession.archiveSession).not.toHaveBeenCalled();
      expect(deps.manageSession.createSession).not.toHaveBeenCalled();
    });

    /**
     * 防御路径：无 active session 时跳过 archive 直接建新 session。
     * F20260805rsto 后正常獭恒有 active session（CreateOtter 建账 + 启动迁移 + invoke 兜底），
     * 此路径在生产应不可达，保留仅为控制器防御分支的回归守护。
     */
    it("creates new session when no active session exists", async () => {
      const newSession = makeSession({ id: "fresh-session" });
      deps.manageSession.getActiveSession.mockResolvedValue(null);
      deps.manageSession.createSession.mockResolvedValue(newSession);

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
      });

      expect(res.status).toBe(201);
      expect(deps.manageSession.archiveSession).not.toHaveBeenCalled();
      expect(deps.manageSession.createSession).toHaveBeenCalledWith("otter-1", { summary: undefined });
    });
  });
});
