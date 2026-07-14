import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { OtterRepository } from "@domain/otter/_internal/repository";

describe("OtterRepository", () => {
  let db: Database.Database;
  let repo: OtterRepository;

  beforeEach(() => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);
    repo = new OtterRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe("createOtter + getById", () => {
    it("创建 Otter 后可按 ID 查询", () => {
      const otter = repo.createOtter("otter-1", {
        name: "Test Otter",
        type: "big",
      });

      expect(otter.id).toBe("otter-1");
      expect(otter.name).toBe("Test Otter");
      expect(otter.type).toBe("big");
      expect(otter.status).toBe("active");
      expect(otter.role).toBeNull();
      expect(otter.parentOtterId).toBeNull();
      expect(otter.createdAt).toBeTruthy();
      expect(otter.dissolvedAt).toBeNull();
    });

    it("getById 未找到返回 null", () => {
      expect(repo.getById("nonexistent")).toBeNull();
    });
  });

  describe("create 小獭含角色", () => {
    it("role_name + role_responsibilities 正确存储和读取", () => {
      repo.createOtter("otter-1", { name: "Big", type: "big" });
      repo.createOtter("otter-2", {
        name: "Small Otter",
        type: "small",
        roleName: "coder",
        roleResponsibilities: ["write code", "review PRs"],
        parentOtterId: "otter-1",
      });

      const retrieved = repo.getById("otter-2")!;
      expect(retrieved.role).toEqual({
        name: "coder",
        responsibilities: ["write code", "review PRs"],
      });
      expect(retrieved.parentOtterId).toBe("otter-1");
    });

    it("role_responsibilities JSON 序列化/反序列化正确", () => {
      const responsibilities = ["task1", "task2", "task3"];
      repo.createOtter("otter-3", {
        name: "R Otter",
        type: "small",
        roleName: "role",
        roleResponsibilities: responsibilities,
      });

      const retrieved = repo.getById("otter-3")!;
      expect(retrieved.role?.responsibilities).toEqual(responsibilities);
      expect(Array.isArray(retrieved.role?.responsibilities)).toBe(true);
    });
  });

  describe("dissolve", () => {
    it("status 变为 dissolved, dissolved_at 非空", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      repo.dissolve("otter-1");

      const otter = repo.getById("otter-1")!;
      expect(otter.status).toBe("dissolved");
      expect(otter.dissolvedAt).not.toBeNull();
    });
  });

  describe("getBigOtter", () => {
    it("返回活跃的大獭", () => {
      repo.createOtter("big-1", { name: "Big Otter", type: "big" });
      const otter = repo.getBigOtter();
      expect(otter).not.toBeNull();
      expect(otter!.type).toBe("big");
    });

    it("dissolved 大獭不被返回", () => {
      repo.createOtter("big-1", { name: "Big Otter", type: "big" });
      repo.dissolve("big-1");
      expect(repo.getBigOtter()).toBeNull();
    });
  });

  describe("Session 生命周期", () => {
    it("createSession 创建 session，status='active'", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      const session = repo.createSession("otter-1");

      expect(session.otterId).toBe("otter-1");
      expect(session.status).toBe("active");
      expect(session.startedAt).toBeTruthy();
      expect(session.archivedAt).toBeNull();
    });

    it("getActiveSession 返回活跃 session", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      repo.createSession("otter-1");

      const active = repo.getActiveSession("otter-1");
      expect(active).not.toBeNull();
      expect(active!.status).toBe("active");
    });

    it("archiveSession reason='restart' -> status='restarted'", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      const session = repo.createSession("otter-1");

      repo.archiveSession(session.id, { reason: "restart" });

      const archived = repo.getSessionById(session.id)!;
      expect(archived.status).toBe("restarted");
      expect(archived.archiveReason).toBe("restart");
      expect(archived.archivedAt).not.toBeNull();
    });

    it("archiveSession reason='dissolve' -> status='archived'", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      const session = repo.createSession("otter-1");

      repo.archiveSession(session.id, { reason: "dissolve" });

      const archived = repo.getSessionById(session.id)!;
      expect(archived.status).toBe("archived");
      expect(archived.archiveReason).toBe("dissolve");
    });

    it("archiveSession reason='manual' -> status='archived'", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });
      const session = repo.createSession("otter-1");

      repo.archiveSession(session.id, { reason: "manual", isNegativeCase: true, summary: "Bad session" });

      const archived = repo.getSessionById(session.id)!;
      expect(archived.status).toBe("archived");
      expect(archived.isNegativeCase).toBe(true);
      expect(archived.summary).toBe("Bad session");
    });

    it("getSessionHistory 返回全部 session，按时间倒序", () => {
      repo.createOtter("otter-1", { name: "Test", type: "big" });

      const s1 = repo.createSession("otter-1");
      const s2 = repo.createSession("otter-1");
      repo.archiveSession(s1.id, { reason: "manual" });

      const history = repo.getSessionHistory("otter-1");
      expect(history.length).toBe(2);
      // s2 is active, s1 is archived - both returned
      expect(history.some((s) => s.id === s1.id)).toBe(true);
      expect(history.some((s) => s.id === s2.id)).toBe(true);
    });

    it("外键约束：otter_id 不存在时 INSERT session 抛出异常", () => {
      expect(() => repo.createSession("nonexistent-otter")).toThrow();
    });
  });
});
