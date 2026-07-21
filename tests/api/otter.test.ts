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

  // ─── GET /api/otters/big ───

  describe("GET /api/otters/big", () => {
    it("returns the big otter", async () => {
      const bigOtter = makeOtter({ id: "big-1", type: "big", name: "Big Otter" });
      deps.queryOtter.getBigOtter.mockResolvedValue(bigOtter);

      const res = await app.request("/api/otters/big");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe("big-1");
      expect(body.type).toBe("big");
    });

    it("returns 404 when big otter not found", async () => {
      deps.queryOtter.getBigOtter.mockRejectedValue(
        new DomainError("Big Otter not found", "not_found"),
      );

      const res = await app.request("/api/otters/big");
      expect(res.status).toBe(404);
    });
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

  // ─── POST /api/otters/:id/sessions ───

  describe("POST /api/otters/:id/sessions", () => {
    it("creates a new session", async () => {
      const session = makeSession({ id: "new-session" });
      deps.manageSession.createSession.mockResolvedValue(session);

      const res = await app.request("/api/otters/otter-1/sessions", {
        method: "POST",
      });

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBe("new-session");
    });

    it("returns 409 when active session already exists", async () => {
      deps.manageSession.createSession.mockRejectedValue(
        new DomainError("Otter otter-1 already has an active session: s1", "conflict"),
      );

      const res = await app.request("/api/otters/otter-1/sessions", {
        method: "POST",
      });

      expect(res.status).toBe(409);
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
      expect(deps.manageSession.createSession).toHaveBeenCalledWith("otter-1");
    });

    it("creates new session when no active session exists", async () => {
      const newSession = makeSession({ id: "fresh-session" });
      deps.manageSession.getActiveSession.mockResolvedValue(null);
      deps.manageSession.createSession.mockResolvedValue(newSession);

      const res = await app.request("/api/otters/otter-1/restart", {
        method: "POST",
      });

      expect(res.status).toBe(201);
      expect(deps.manageSession.archiveSession).not.toHaveBeenCalled();
      expect(deps.manageSession.createSession).toHaveBeenCalledWith("otter-1");
    });
  });
});
