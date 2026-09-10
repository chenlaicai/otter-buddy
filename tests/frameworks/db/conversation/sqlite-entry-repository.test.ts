import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import type { Entry } from "@entities/conversation/entry";

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

/** 插入 turn 记录 */
function insertTurn(db: Database.Database, id: string, conversationId: string): void {
  db.prepare(`
    INSERT INTO turns (id, conversation_id, turn_number, status, created_at)
    VALUES (?, ?, 1, 'open', '2026-09-10T00:00:00Z')
  `).run(id, conversationId);
}

/** 构造测试用 Entry 实体 */
function entryFixture(overrides: Partial<Entry> = {}): Entry {
  const id = overrides.id ?? "entry-1";
  return {
    id,
    conversationId: "conv-1",
    sequenceNum: 1,
    entryType: "speak",
    senderType: "otter",
    senderId: "otter-1",
    body: "你好，我是獭",
    invokeId: null,
    yieldTargets: null,
    turnId: "turn-1",
    status: "completed",
    source: "web",
    metadata: null,
    senderName: "测试獭",
    contextTokens: null,
    contextTokensMax: null,
    createdAt: "2026-09-10T00:01:00Z",
    completedAt: "2026-09-10T00:01:00Z",
    ...overrides,
  };
}

/** 创建测试用 invoke */
async function createTestInvoke(repo: SqliteInvokeRepository, id: string): Promise<void> {
  return repo.createInvoke({
    id,
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
  });
}

describe("SqliteEntryRepository - 条目基础操作", () => {
  let db: Database.Database;
  let repo: SqliteEntryRepository;
  let invokeRepo: SqliteInvokeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteEntryRepository(db);
    invokeRepo = new SqliteInvokeRepository(db);
    insertOtter(db, "otter-1");
    insertConversation(db, "conv-1");
    insertTurn(db, "turn-1", "conv-1");
  });

  afterEach(() => {
    db.close();
  });

  describe("createEntry", () => {
    it("should create a speak entry", async () => {
      const entry = entryFixture();
      await repo.createEntry(entry);

      const loaded = await repo.getEntryById("entry-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.entryType).toBe("speak");
      expect(loaded!.body).toBe("你好，我是獭");
      expect(loaded!.status).toBe("completed");
    });

    it("should create an invoke_start entry", async () => {
      await createTestInvoke(invokeRepo, "invoke-1");
      const entry = entryFixture({
        id: "invoke-start-1",
        entryType: "invoke_start",
        senderType: null,
        senderId: null,
        body: "🦦 测试獭开始行动～",
        invokeId: "invoke-1",
      });
      await repo.createEntry(entry);

      const loaded = await repo.getEntryById("invoke-start-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.entryType).toBe("invoke_start");
      expect(loaded!.body).toBe("🦦 测试獭开始行动～");
    });

    it("should create a yield entry", async () => {
      await createTestInvoke(invokeRepo, "invoke-1");
      const entry = entryFixture({
        id: "yield-1",
        entryType: "yield",
        senderType: null,
        senderId: null,
        body: "→ 交给 测试獭",
        invokeId: "invoke-1",
        yieldTargets: ["otter-1"],
      });
      await repo.createEntry(entry);

      const loaded = await repo.getEntryById("yield-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.entryType).toBe("yield");
      expect(loaded!.yieldTargets).toEqual(["otter-1"]);
    });
  });

  describe("getEntries", () => {
    it("should get entries by conversation", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", sequenceNum: 1 }));
      await repo.createEntry(entryFixture({ id: "entry-2", sequenceNum: 2 }));
      await repo.createEntry(entryFixture({ id: "entry-3", sequenceNum: 3 }));

      const entries = await repo.getEntries("conv-1");
      expect(entries.length).toBe(3);
      expect(entries[0].sequenceNum).toBe(3); // DESC order
    });

    it("should filter by entry type", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", entryType: "speak", sequenceNum: 1 }));
      await repo.createEntry(entryFixture({ id: "entry-2", entryType: "user", sequenceNum: 2, senderType: "user", senderId: "user-1" }));
      await repo.createEntry(entryFixture({ id: "entry-3", entryType: "speak", sequenceNum: 3 }));

      const speakEntries = await repo.getEntries("conv-1", { entryType: "speak" });
      expect(speakEntries.length).toBe(2);
      expect(speakEntries.every(e => e.entryType === "speak")).toBe(true);
    });

    it("should filter by status", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", status: "completed", sequenceNum: 1 }));
      await repo.createEntry(entryFixture({ id: "entry-2", status: "streaming", sequenceNum: 2 }));

      const completed = await repo.getEntries("conv-1", { status: "completed" });
      expect(completed.length).toBe(1);
      expect(completed[0].status).toBe("completed");
    });
  });

  describe("updateEntryStatus", () => {
    it("should update entry status", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", status: "streaming" }));
      await repo.updateEntryStatus("entry-1", "completed", "2026-09-10T00:02:00Z");

      const loaded = await repo.getEntryById("entry-1");
      expect(loaded!.status).toBe("completed");
      expect(loaded!.completedAt).toBe("2026-09-10T00:02:00Z");
    });
  });

  describe("updateEntryBody", () => {
    it("should update entry body and FTS", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", body: "原始内容" }));
      await repo.updateEntryBody("entry-1", "新内容");

      const loaded = await repo.getEntryById("entry-1");
      expect(loaded!.body).toBe("新内容");

      const searchResults = await repo.searchEntries("conv-1", "新内容");
      expect(searchResults.length).toBe(1);
      expect(searchResults[0].id).toBe("entry-1");
    });
  });

  describe("searchEntries", () => {
    it("should search entries by body", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", body: "这是一个测试消息" }));
      await repo.createEntry(entryFixture({ id: "entry-2", body: "另一个消息", sequenceNum: 2 }));

      // trigram 分词需要 ≥3 字符的查询词
      const results = await repo.searchEntries("conv-1", "这是一个");
      expect(results.length).toBe(1);
      expect(results[0].body).toBe("这是一个测试消息");
    });
  });

  describe("getMaxSequenceNum", () => {
    it("should return max sequence number", async () => {
      await repo.createEntry(entryFixture({ id: "entry-1", sequenceNum: 5 }));
      await repo.createEntry(entryFixture({ id: "entry-2", sequenceNum: 10 }));

      const maxSeq = await repo.getMaxSequenceNum("conv-1");
      expect(maxSeq).toBe(10);
    });

    it("should return 0 for empty conversation", async () => {
      const maxSeq = await repo.getMaxSequenceNum("conv-empty");
      expect(maxSeq).toBe(0);
    });
  });
});
