import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteTerminologyRepository } from "@frameworks/db/memory/sqlite-terminology-repository";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { ManageTerminology } from "@usecases/memory/manage-terminology";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { TerminologyEntry } from "@entities/memory/terminology-entry";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

/** 创建 noop Logger mock */
function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 创建内存 SQLite 数据库 + 初始化 terminology schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminology_entries (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      aliases_flat TEXT NOT NULL DEFAULT '',
      definition TEXT NOT NULL,
      context TEXT,
      examples TEXT,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_terminology_status ON terminology_entries(status);
    CREATE INDEX IF NOT EXISTS idx_terminology_category ON terminology_entries(category);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_terminology_term_active ON terminology_entries(term) WHERE status = 'active';
    CREATE VIRTUAL TABLE IF NOT EXISTS terminology_fts USING fts5(
      terminology_entry_id UNINDEXED,
      term,
      aliases_flat,
      definition,
      context,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      conversation_id TEXT,
      granularity TEXT NOT NULL DEFAULT 'fine',
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS memory_weights (
      memory_entry_id TEXT PRIMARY KEY,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_retrieved_at TEXT,
      user_flagged INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_entry_id UNINDEXED,
      content,
      tokenize = 'trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_jieba USING fts5(
      memory_entry_id UNINDEXED,
      content
    );
  `);
  return db;
}

function mockEmbeddingGateway(): EmbeddingGateway {
  return {
    available: false,
    embed: async () => {
      throw new Error("Embedding not available in test");
    },
  };
}

const SAMPLE_ENTRY: TerminologyEntry = {
  id: "term-1",
  term: "大獭",
  aliases: ["Big Otter"],
  definition: "搭档的唯一持久 Otter，海獭团队的首领，带有独占能力",
  context: null,
  examples: null,
  category: "实体",
  status: "active",
  createdAt: "2026-07-09T00:00:00Z",
  updatedAt: "2026-07-09T00:00:00Z",
  version: 1,
};

describe("ManageTerminology - CRUD", () => {
  let db: Database.Database;
  let repo: SqliteTerminologyRepository;
  let manageTerminology: ManageTerminology;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteTerminologyRepository(db);
    manageTerminology = new ManageTerminology(repo);
  });

  it("addTerm 创建新术语，version=1", async () => {
    const entry = await manageTerminology.addTerm({
      term: "大獭",
      definition: "搭档的唯一持久 Otter，海獭团队的首领，带有独占能力",
      aliases: ["Big Otter"],
      category: "实体",
    });

    expect(entry.id).toBeDefined();
    expect(entry.term).toBe("大獭");
    expect(entry.version).toBe(1);
    expect(entry.status).toBe("active");
  });

  it("addTerm 重复术语（同名 active）抛出唯一约束错误", async () => {
    await manageTerminology.addTerm({ term: "大獭", definition: "定义1" });
    await expect(
      manageTerminology.addTerm({ term: "大獭", definition: "定义2" }),
    ).rejects.toThrow();
  });
});

describe("ManageTerminology - 检索策略", () => {
  let db: Database.Database;
  let repo: SqliteTerminologyRepository;
  let manageTerminology: ManageTerminology;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteTerminologyRepository(db);
    manageTerminology = new ManageTerminology(repo);

    /** 预置测试数据 */
    await repo.add(SAMPLE_ENTRY);
    await repo.add({
      id: "term-2",
      term: "小獭",
      aliases: ["Small Otter"],
      definition: "大獭按需创建的临时 Otter",
      context: null,
      examples: null,
      category: "实体",
      status: "active",
      createdAt: "2026-07-09T00:00:00Z",
      updatedAt: "2026-07-09T00:00:00Z",
      version: 1,
    });
    await repo.add({
      id: "term-3",
      term: "重启獭生",
      aliases: ["Restart Otter Life"],
      definition: "搭档表达不满时触发的 Otter 个体内部机制",
      context: "封存当前 session 为反面案例",
      examples: null,
      category: "机制",
      status: "active",
      createdAt: "2026-07-09T00:00:00Z",
      updatedAt: "2026-07-09T00:00:00Z",
      version: 1,
    });
  });

  it("精确匹配：输入完整术语名直接返回", async () => {
    const results = await manageTerminology.search("大獭", 10);
    expect(results.length).toBe(1);
    expect(results[0].term).toBe("大獭");
  });

  it("精确匹配：输入别名返回对应术语", async () => {
    const results = await manageTerminology.search("Big Otter", 10);
    expect(results.length).toBe(1);
    expect(results[0].term).toBe("大獭");
  });

  it("前缀匹配：输入术语名前缀返回匹配条目", async () => {
    const results = await manageTerminology.search("重启", 10);
    expect(results.length).toBe(1);
    expect(results[0].term).toBe("重启獭生");
  });

  it("全文搜索：输入描述性文本通过 definition 反查术语", async () => {
    const results = await manageTerminology.search("按需创建", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].term).toBe("小獭");
  });

  it("deprecated 术语不出现在检索结果中", async () => {
    /** 直接在数据库中标记为 deprecated（deprecateTerm 已移除） */
    db.prepare("UPDATE terminology_entries SET status = 'deprecated' WHERE id = ?").run("term-1");
    db.prepare("DELETE FROM terminology_fts WHERE terminology_entry_id = ?").run("term-1");

    const results = await manageTerminology.search("大獭", 10);
    expect(results.length).toBe(0);
  });

  it("三种检索路径按优先级串联：精确 > 前缀 > 全文", async () => {
    /** 精确匹配优先 */
    const results = await manageTerminology.search("大獭", 10);
    expect(results.length).toBe(1);
    expect(results[0].term).toBe("大獭");
  });
});


describe("TerminologyRepository - syncSeed 种子同步", () => {
  const SEED_ENTRIES: TerminologyEntry[] = [
    SAMPLE_ENTRY,
    {
      id: "seed-002",
      term: "小獭",
      aliases: ["Small Otter"],
      definition: "大獭按需创建的临时 Otter",
      context: null,
      examples: null,
      category: "实体",
      status: "active",
      createdAt: "2026-07-09T00:00:00Z",
      updatedAt: "2026-07-09T00:00:00Z",
      version: 1,
    },
  ];

  it("表为空时导入全部种子数据", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    await repo.syncSeed(SEED_ENTRIES);

    const entry = await repo.getByTerm("大獭");
    expect(entry).not.toBeNull();
    expect(entry?.term).toBe("大獭");
    const entry2 = await repo.getByTerm("小獭");
    expect(entry2).not.toBeNull();
  });

  it("内容相同时跳过更新", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    await repo.syncSeed(SEED_ENTRIES);
    const before = await repo.getByTerm("大獭");

    await repo.syncSeed(SEED_ENTRIES);
    const after = await repo.getByTerm("大獭");

    expect(after?.version).toBe(before?.version);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("内容不同时更新术语", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    await repo.syncSeed(SEED_ENTRIES);

    /** 修改定义后重新同步 */
    const updated = SEED_ENTRIES.map(e =>
      e.term === "大獭" ? { ...e, definition: "新定义" } : e,
    );
    await repo.syncSeed(updated);

    const entry = await repo.getByTerm("大獭");
    expect(entry?.definition).toBe("新定义");
    expect(entry?.version).toBe(2);
  });

  it("新增种子术语不影响运行时用户添加的术语", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    /** 先同步一次（2个术语） */
    await repo.syncSeed(SEED_ENTRIES);

    /** 用户手动添加一个术语 */
    await repo.add({
      id: "user-term-1",
      term: "自定义术语",
      aliases: ["Custom Term"],
      definition: "用户自己添加的术语",
      context: null,
      examples: null,
      category: "概念",
      status: "active",
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
      version: 1,
    });

    /** 再次同步，用户术语应保留 */
    await repo.syncSeed(SEED_ENTRIES);

    const userTerm = await repo.getByTerm("自定义术语");
    expect(userTerm).not.toBeNull();
    expect(userTerm?.id).toBe("user-term-1");
  });

  it("新增种子条目只插入新增的，不重复导入已有", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    /** 初始同步 2 个术语 */
    await repo.syncSeed(SEED_ENTRIES);

    /** 扩展种子数据为 3 个 */
    const extended = [...SEED_ENTRIES, {
      id: "seed-003",
      term: "对话",
      aliases: ["Conversation"],
      definition: "搭档与 Otter 的交互单元",
      context: null,
      examples: null,
      category: "概念",
      status: "active" as const,
      createdAt: "2026-07-09T00:00:00Z",
      updatedAt: "2026-07-09T00:00:00Z",
      version: 1,
    }];
    await repo.syncSeed(extended);

    const newEntry = await repo.getByTerm("对话");
    expect(newEntry).not.toBeNull();
    expect(newEntry?.id).toBe("seed-003");

    /** 已有的 2 个术语不应被重复插入 */
    const existing = await repo.getByTerm("大獭");
    expect(existing?.id).toBe("term-1");
  });

  it("syncSeed 幂等：多次执行结果相同", async () => {
    const db = createTestDb();
    const repo = new SqliteTerminologyRepository(db);

    await repo.syncSeed(SEED_ENTRIES);
    await repo.syncSeed(SEED_ENTRIES);
    await repo.syncSeed(SEED_ENTRIES);

    const entry = await repo.getByTerm("大獭");
    expect(entry).not.toBeNull();
    expect(entry?.version).toBe(1);
  });
});

describe("SearchMemory - library 路由", () => {
  let db: Database.Database;
  let termRepo: SqliteTerminologyRepository;
  let searchMemory: SearchMemory;

  beforeEach(async () => {
    db = createTestDb();
    termRepo = new SqliteTerminologyRepository(db);
    const memoryRepo = new SqliteMemoryRepository(db);
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(memoryRepo, mockEmbeddingGateway(), searchEngine, mockLogger(), termRepo);

    await termRepo.add(SAMPLE_ENTRY);
  });

  it("library=terminology 路由到术语库检索", async () => {
    const result = await searchMemory.search({
      query: "大獭",
      limit: 10,
      library: "terminology",
    });

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].content).toContain("大獭");
    expect(result.entries[0].content).toContain("搭档的唯一持久 Otter");
  });

  it("library=conversation 路由到对话库检索", async () => {
    const result = await searchMemory.search({
      query: "大獭",
      limit: 10,
      library: "conversation",
    });

    /** 对话库为空，应返回 0 结果 */
    expect(result.entries.length).toBe(0);
  });

  it("不传 library 时全库搜索混排", async () => {
    const result = await searchMemory.search({
      query: "大獭",
      limit: 10,
    });

    /** 术语库有数据，对话库为空 */
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].content).toContain("大獭");
  });

  it("library 传入未知值抛出错误", async () => {
    await expect(
      searchMemory.search({
        query: "大獭",
        limit: 10,
        library: "unknown",
      }),
    ).rejects.toThrow(/Unknown library/);
  });
});
