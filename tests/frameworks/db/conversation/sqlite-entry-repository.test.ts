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

/** 插入 attachments + entry_attachments 种子（delta 回修：真 sqlite 投影断言） */
function insertAttachment(db: Database.Database, attId: string, entryId: string, seq: number): void {
  db.prepare(`
    INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, width, height, caption, uploader_id)
    VALUES (?, ?, ?, ?, ?, 'image', 123, 800, 600, NULL, 'user-1')
  `).run(attId, `sha-${attId}`, `/tmp/${attId}.png`, `${attId}.png`, "image/png");
  db.prepare(`
    INSERT INTO entry_attachments (entry_id, attachment_id, sequence_num)
    VALUES (?, ?, ?)
  `).run(entryId, attId, seq);
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

describe("SqliteEntryRepository - 附件投影（F20260913ctlv delta 回修：真 sqlite，堵 mock 盲区）", () => {
  let db: Database.Database;
  let repo: SqliteEntryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteEntryRepository(db);
    insertOtter(db, "otter-1");
    insertConversation(db, "conv-1");
    insertTurn(db, "turn-1", "conv-1");
  });

  afterEach(() => {
    db.close();
  });

  it("getEntryById 投影含真实附件 id/mimeType/width/height（非占位空值）", async () => {
    // 落一条 user entry + 两个附件关联
    await repo.createEntry(entryFixture({ id: "entry-att", entryType: "user", senderType: "user", senderId: "user-1" }));
    insertAttachment(db, "att-real-1", "entry-att", 0);
    insertAttachment(db, "att-real-2", "entry-att", 1);

    const entry = await repo.getEntryById("entry-att");
    expect(entry).not.toBeNull();
    expect(entry!.attachments).toHaveLength(2);
    // 核心断言：投影真值（回修前 id:""/mimeType:""/width:null 占位 → 破图 404）
    expect(entry!.attachments![0]!.id).toBe("att-real-1");
    expect(entry!.attachments![0]!.mimeType).toBe("image/png");
    expect(entry!.attachments![0]!.width).toBe(800);
    expect(entry!.attachments![0]!.height).toBe(600);
    expect(entry!.attachments![0]!.originalName).toBe("att-real-1.png");
    expect(entry!.attachments![0]!.sizeBytes).toBe(123);
    // 按挂载序排列
    expect(entry!.attachments![1]!.id).toBe("att-real-2");
  });

  it("getEntries 批量路径投影同真值（历史端点数据源）", async () => {
    await repo.createEntry(entryFixture({ id: "entry-att2", entryType: "user", senderType: "user", senderId: "user-1" }));
    insertAttachment(db, "att-real-3", "entry-att2", 0);

    const entries = await repo.getEntries("conv-1", { limit: 50 });
    const withAtt = entries.find(e => e.id === "entry-att2");
    expect(withAtt?.attachments).toHaveLength(1);
    expect(withAtt!.attachments![0]!.id).toBe("att-real-3");
    expect(withAtt!.attachments![0]!.mimeType).toBe("image/png");
    expect(withAtt!.attachments![0]!.width).toBe(800);
  });

  it("无附件条目 attachments 字段不携带（undefined 而非空数组）", async () => {
    await repo.createEntry(entryFixture({ id: "entry-plain" }));
    const entry = await repo.getEntryById("entry-plain");
    expect(entry!.attachments).toBeUndefined();
  });
});

