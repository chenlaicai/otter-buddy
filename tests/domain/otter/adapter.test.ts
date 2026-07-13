import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { OtterRepository } from "@domain/otter/_internal/repository";
import { OtterAdapter } from "@domain/otter/_internal/adapter";
import type { AgentLifecyclePort } from "@domain/otter/_internal/adapter";
import type { OtterPort } from "@domain/otter/port";

/** 创建 mock AgentLifecyclePort */
function createMockAgentLifecycle(): AgentLifecyclePort & {
  createdOtters: Set<string>;
  destroyedOtters: Set<string>;
  resetOtters: Set<string>;
} {
  return {
    createdOtters: new Set<string>(),
    destroyedOtters: new Set<string>(),
    resetOtters: new Set<string>(),
    create(otterId: string) {
      this.createdOtters.add(otterId);
    },
    destroy(otterId: string) {
      this.destroyedOtters.add(otterId);
    },
    reset(otterId: string) {
      this.resetOtters.add(otterId);
    },
  };
}

describe("OtterAdapter", () => {
  let db: Database.Database;
  let repo: OtterRepository;
  let agentLifecycle: ReturnType<typeof createMockAgentLifecycle>;
  let port: OtterPort;

  beforeEach(() => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);
    repo = new OtterRepository(db);
    agentLifecycle = createMockAgentLifecycle();
    port = new OtterAdapter(repo, agentLifecycle);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe("create", () => {
    it("同时创建数据记录和 Agent 实例", async () => {
      const otter = await port.create({
        name: "Big Otter",
        type: "big",
        systemPrompt: "You are a big otter",
      });

      expect(otter.id).toBeTruthy();
      expect(otter.name).toBe("Big Otter");
      expect(otter.type).toBe("big");
      expect(agentLifecycle.createdOtters.has(otter.id)).toBe(true);
    });

    it("create 生成有效 UUID", async () => {
      const otter = await port.create({ name: "Test", type: "small" });

      // UUID v4 format
      expect(otter.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("小獭角色信息正确存储", async () => {
      const bigOtter = await port.create({ name: "Big", type: "big" });
      const smallOtter = await port.create({
        name: "Coder",
        type: "small",
        roleName: "developer",
        roleResponsibilities: ["write code", "debug"],
        parentOtterId: bigOtter.id,
      });

      expect(smallOtter.role).toEqual({
        name: "developer",
        responsibilities: ["write code", "debug"],
      });
      expect(smallOtter.parentOtterId).toBe(bigOtter.id);
    });
  });

  describe("getBigOtter", () => {
    it("找到大獭时返回", async () => {
      await port.create({ name: "Big", type: "big" });
      const otter = await port.getBigOtter();
      expect(otter.type).toBe("big");
    });

    it("找不到时 throw", async () => {
      await expect(port.getBigOtter()).rejects.toThrow(/Big Otter not found/);
    });
  });

  describe("dissolve", () => {
    it("同时更新数据和销毁 Agent", async () => {
      const otter = await port.create({ name: "Small", type: "small" });
      await port.dissolve(otter.id);

      const dissolved = await port.getById(otter.id);
      expect(dissolved!.status).toBe("dissolved");
      expect(dissolved!.dissolvedAt).not.toBeNull();
      expect(agentLifecycle.destroyedOtters.has(otter.id)).toBe(true);
    });

    it("dissolve 不存在的 otter 抛出异常", async () => {
      await expect(port.dissolve("nonexistent")).rejects.toThrow(/Otter not found/);
    });
  });

  describe("Session 生命周期", () => {
    it("createSession + getActiveSession 全流程", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const session = await port.createSession(otter.id);

      expect(session.status).toBe("active");
      expect(session.otterId).toBe(otter.id);

      const active = await port.getActiveSession(otter.id);
      expect(active!.id).toBe(session.id);
    });

    it("archiveSession 触发 AgentLifecycle.reset", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const session = await port.createSession(otter.id);

      await port.archiveSession(session.id, { reason: "restart" });

      expect(agentLifecycle.resetOtters.has(otter.id)).toBe(true);
    });

    it("archiveSession reason='restart' -> status='restarted'", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const session = await port.createSession(otter.id);

      await port.archiveSession(session.id, { reason: "restart" });
      const history = await port.getSessionHistory(otter.id);
      const archived = history.find((s) => s.id === session.id)!;
      expect(archived.status).toBe("restarted");
    });

    it("archiveSession reason='manual' -> status='archived'", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const session = await port.createSession(otter.id);

      await port.archiveSession(session.id, { reason: "manual" });
      const history = await port.getSessionHistory(otter.id);
      const archived = history.find((s) => s.id === session.id)!;
      expect(archived.status).toBe("archived");
    });

    it("archiveSession 不存在的 session 抛出异常", async () => {
      await expect(
        port.archiveSession("nonexistent", { reason: "manual" }),
      ).rejects.toThrow(/Session not found/);
    });

    it("archiveSession 已归档的 session 抛出异常", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const session = await port.createSession(otter.id);

      await port.archiveSession(session.id, { reason: "manual" });
      await expect(
        port.archiveSession(session.id, { reason: "manual" }),
      ).rejects.toThrow(/not active/);
    });

    it("getSessionHistory 返回全部 session 按倒序", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      await port.createSession(otter.id);
      await port.createSession(otter.id);

      const history = await port.getSessionHistory(otter.id);
      expect(history.length).toBe(2);
    });
  });

  describe("CRUD 全流程", () => {
    it("create -> getById -> dissolve", async () => {
      const otter = await port.create({ name: "Test", type: "big" });
      const retrieved = await port.getById(otter.id);
      expect(retrieved!.name).toBe("Test");

      await port.dissolve(otter.id);
      const dissolved = await port.getById(otter.id);
      expect(dissolved!.status).toBe("dissolved");
    });

    it("getById 未找到返回 null", async () => {
      expect(await port.getById("nonexistent")).toBeNull();
    });
  });
});

void vi;
