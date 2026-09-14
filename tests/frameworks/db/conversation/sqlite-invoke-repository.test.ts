import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import type { Invoke } from "@entities/conversation/invoke";

/** 创建内存 SQLite 数据库并初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** 插入 otter 记录（外键依赖） */
function insertOtter(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO otters (id, name, type, created_at)
    VALUES (?, 'test-otter', 'assistant', '2026-09-10T00:00:00Z')
  `).run(id);
}

/** 插入 conversation 记录 */
function insertConversation(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at)
    VALUES (?, '测试对话', 'active', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')
  `).run(id);
}

/** 构造测试用 Invoke 实体 */
function invokeFixture(overrides: Partial<Invoke> = {}): Invoke {
  return {
    id: "invoke-1",
    conversationId: "conv-1",
    otterId: "otter-1",
    status: "running",
    triggerEntryId: null,
    talkingStonePassedTo: null,
    startedAt: "2026-09-10T00:01:00Z",
    endedAt: null,
    toolCallCount: 0,
    tokenUsageInput: null,
    tokenUsageOutput: null,
    metadata: null,
    ...overrides,
  };
}

describe("SqliteInvokeRepository - Invoke 基础操作", () => {
  let db: Database.Database;
  let repo: SqliteInvokeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteInvokeRepository(db);
    insertOtter(db, "otter-1");
    insertConversation(db, "conv-1");
  });

  afterEach(() => {
    db.close();
  });

  describe("createInvoke", () => {
    it("should create a running invoke", async () => {
      const invoke = invokeFixture();
      await repo.createInvoke(invoke);

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe("running");
      expect(loaded!.otterId).toBe("otter-1");
      expect(loaded!.conversationId).toBe("conv-1");
    });
  });

  describe("updateInvokeStatus", () => {
    it("should update invoke status to completed", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeStatus("invoke-1", "completed", "2026-09-10T00:02:00Z");

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.status).toBe("completed");
      expect(loaded!.endedAt).toBe("2026-09-10T00:02:00Z");
    });

    it("should update invoke status to failed", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeStatus("invoke-1", "failed", "2026-09-10T00:02:00Z");

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.status).toBe("failed");
    });

    it("should update invoke status without endedAt", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeStatus("invoke-1", "completed");

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.status).toBe("completed");
      expect(loaded!.endedAt).toBeNull();
    });
  });

  describe("updateInvokeTalkingStonePassedTo", () => {
    it("should update talking stone passed to", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeTalkingStonePassedTo("invoke-1", ["otter-2"]);

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.talkingStonePassedTo).toEqual(["otter-2"]);
    });
  });

  describe("updateInvokeToolCallCount", () => {
    it("should update tool call count", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeToolCallCount("invoke-1", 5);

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.toolCallCount).toBe(5);
    });
  });

  describe("updateInvokeTokenUsage", () => {
    it("should update token usage", async () => {
      await repo.createInvoke(invokeFixture());
      await repo.updateInvokeTokenUsage("invoke-1", 1000, 500);

      const loaded = await repo.getInvokeById("invoke-1");
      expect(loaded!.tokenUsageInput).toBe(1000);
      expect(loaded!.tokenUsageOutput).toBe(500);
    });
  });

  describe("getInvokes", () => {
    it("should get invokes by conversation", async () => {
      await repo.createInvoke(invokeFixture({ id: "invoke-1", startedAt: "2026-09-10T00:01:00Z" }));
      await repo.createInvoke(invokeFixture({ id: "invoke-2", startedAt: "2026-09-10T00:02:00Z" }));

      const invokes = await repo.getInvokes("conv-1");
      expect(invokes.length).toBe(2);
      expect(invokes[0].startedAt).toBe("2026-09-10T00:02:00Z"); // DESC order
    });

    it("should filter by status", async () => {
      await repo.createInvoke(invokeFixture({ id: "invoke-1", status: "running" }));
      await repo.createInvoke(invokeFixture({ id: "invoke-2", status: "completed" }));

      const running = await repo.getInvokes("conv-1", { status: "running" });
      expect(running.length).toBe(1);
      expect(running[0].status).toBe("running");
    });

    it("should filter by otterId", async () => {
      insertOtter(db, "otter-2");
      await repo.createInvoke(invokeFixture({ id: "invoke-1", otterId: "otter-1" }));
      await repo.createInvoke(invokeFixture({ id: "invoke-2", otterId: "otter-2" }));

      const otter1Invokes = await repo.getInvokes("conv-1", { otterId: "otter-1" });
      expect(otter1Invokes.length).toBe(1);
      expect(otter1Invokes[0].otterId).toBe("otter-1");
    });
  });

  describe("getActiveInvokeByOtterId", () => {
    it("should get active invoke for otter", async () => {
      await repo.createInvoke(invokeFixture({ id: "invoke-1", status: "running" }));
      await repo.createInvoke(invokeFixture({ id: "invoke-2", status: "completed" }));

      const active = await repo.getActiveInvokeByOtterId("conv-1", "otter-1");
      expect(active).not.toBeNull();
      expect(active!.status).toBe("running");
    });

    it("should return null if no active invoke", async () => {
      await repo.createInvoke(invokeFixture({ id: "invoke-1", status: "completed" }));

      const active = await repo.getActiveInvokeByOtterId("conv-1", "otter-1");
      expect(active).toBeNull();
    });
  });

  describe("appendInvokeEvent", () => {
    it("should append invoke event", async () => {
      await repo.createInvoke(invokeFixture());

      await repo.appendInvokeEvent({
        id: "event-1",
        invokeId: "invoke-1",
        eventType: "assistant_text",
        payload: { content: "这是助手的回复" },
        sequenceNum: 1,
        createdAt: "2026-09-10T00:01:30Z",
      });

      const events = await repo.getInvokeEvents("invoke-1");
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe("assistant_text");
      expect(events[0].payload).toEqual({ content: "这是助手的回复" });
    });
  });

  describe("getInvokeEvents", () => {
    it("should get invoke events in order", async () => {
      await repo.createInvoke(invokeFixture());

      await repo.appendInvokeEvent({
        id: "event-2",
        invokeId: "invoke-1",
        eventType: "tool_result",
        payload: { result: "成功" },
        sequenceNum: 2,
        createdAt: "2026-09-10T00:01:40Z",
      });

      await repo.appendInvokeEvent({
        id: "event-1",
        invokeId: "invoke-1",
        eventType: "assistant_text",
        payload: { content: "调用工具" },
        sequenceNum: 1,
        createdAt: "2026-09-10T00:01:30Z",
      });

      const events = await repo.getInvokeEvents("invoke-1");
      expect(events.length).toBe(2);
      expect(events[0].sequenceNum).toBe(1);
      expect(events[1].sequenceNum).toBe(2);
    });
  });

  describe("getMaxEventSequenceNum", () => {
    it("should return max sequence number", async () => {
      await repo.createInvoke(invokeFixture());

      await repo.appendInvokeEvent({
        id: "event-1",
        invokeId: "invoke-1",
        eventType: "assistant_text",
        payload: { content: "测试" },
        sequenceNum: 5,
        createdAt: "2026-09-10T00:01:30Z",
      });

      const maxSeq = await repo.getMaxEventSequenceNum("invoke-1");
      expect(maxSeq).toBe(5);
    });

    it("should return 0 for empty invoke", async () => {
      await repo.createInvoke(invokeFixture());

      const maxSeq = await repo.getMaxEventSequenceNum("invoke-1");
      expect(maxSeq).toBe(0);
    });
  });
});
