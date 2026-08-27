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

    it("注入 configProvider 时返回 modelAlias，未配置时字段缺省", async () => {
      deps.queryOtter.getById.mockResolvedValue(makeOtter());
      deps.otterConfigProvider = {
        getConfig: (id: string) => id === "otter-1" ? { otterType: "small", modelAlias: "kimi" } : null,
        setConfig: () => {}, deleteConfig: () => {}, hasConfig: () => false,
      };
      app = createTestApp(deps);

      const res = await app.request("/api/otters/otter-1");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.modelAlias).toBe("kimi");

      deps.otterConfigProvider = undefined;
      app = createTestApp(deps);
      const res2 = await app.request("/api/otters/otter-1");
      const body2 = await json(res2);
      expect("modelAlias" in body2).toBe(false);
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
        systemPrompt: undefined,
        context: undefined,
      });
    });

    it("create 响应注入 configProvider 时返回 modelAlias，未配置时字段缺省（F20260825vrqh 发现 1）", async () => {
      const otter = makeOtter({ id: "new-otter" });
      deps.createOtterUseCase.execute.mockResolvedValue(otter);
      deps.otterConfigProvider = {
        getConfig: (id: string) => id === "new-otter" ? { otterType: "small", modelAlias: "glm" } : null,
        setConfig: () => {}, deleteConfig: () => {}, hasConfig: () => false,
      };
      app = createTestApp(deps);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Friend", type: "small" }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.modelAlias).toBe("glm");

      deps.otterConfigProvider = undefined;
      app = createTestApp(deps);
      const res2 = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Friend", type: "small" }),
      });
      const body2 = await json(res2);
      expect("modelAlias" in body2).toBe(false);
    });

    it("F20260826ucrt T1/T4：透传 modelAlias；parentOtterId 一律忽略（血缘诚实化，UI 创建无獭召唤者）", async () => {
      const otter = makeOtter();
      deps.createOtterUseCase.execute.mockResolvedValue(otter);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Child Otter",
          type: "small",
          role: { name: "coder", responsibilities: ["write code"] },
          modelAlias: "main",
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
        modelAlias: "main",
        parentOtterId: undefined,
        systemPrompt: "You are a coder",
        context: { project: "test" },
      });
    });

    it("F20260826ucrt T1：非法 modelAlias 返回 400 且附可用列表（措辞与大獭工具链 tool-factory 一致）", async () => {
      const otter = makeOtter();
      deps.createOtterUseCase.execute.mockResolvedValue(otter);

      const res = await app.request("/api/otters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Alias Otter",
          type: "small",
          modelAlias: "nonexistent-model",
        }),
      });

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("未知的模型别名「nonexistent-model」");
      expect(body.error).toContain("main"); // 测试 helpers 的 modelPool 含 alias "main"
      expect(deps.createOtterUseCase.execute).not.toHaveBeenCalled();
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
      const newSession = makeSession({ id: "new-session" });
      deps.manageSession.restartSession.mockResolvedValue(newSession);

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Restarting" }),
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-session");
      expect(deps.manageSession.restartSession).toHaveBeenCalledWith("otter-1", "Restarting");
    });

    it("F20260805rsto：小獭不支持重启（重启是大獭专属，小獭用解散），返回 400", async () => {
      deps.queryOtter.getById.mockResolvedValue(makeOtter({ type: "small" }));

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      expect(deps.manageSession.restartSession).not.toHaveBeenCalled();
    });

    it("delegates to restartSession and returns 201", async () => {
      const newSession = makeSession({ id: "fresh-session" });
      deps.manageSession.restartSession.mockResolvedValue(newSession);

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
      });

      expect(res.status).toBe(201);
      expect(deps.manageSession.restartSession).toHaveBeenCalledWith("otter-1", undefined);
    });
  });
});
