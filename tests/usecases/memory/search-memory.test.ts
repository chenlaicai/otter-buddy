import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import { ManageMemory } from "@usecases/memory/manage-memory";
import type { MemoryEntry } from "@entities/memory/memory-entry";
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

/** 创建内存 SQLite 数据库 + 初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
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
  `);
  return db;
}

/** 测试用 EmbeddingGateway mock（vec0 不可用时降级） */
function mockEmbeddingGateway(): EmbeddingGateway {
  return {
    available: false,
    embed: async () => {
      throw new Error("Embedding not available in test");
    },
  };
}

/** 存入一条记忆条目 */
function storeEntry(db: Database.Database, entry: MemoryEntry): void {
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
      conversation_id, granularity, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id, '', entry.contentType, entry.sourceId, entry.sourceTable,
    entry.conversationId ?? null, entry.granularity, entry.content,
    entry.metadata ? JSON.stringify(entry.metadata) : null, entry.createdAt,
  );
  db.prepare(`INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)`)
    .run(entry.id, entry.content);
  db.prepare(`INSERT INTO memory_weights (memory_entry_id) VALUES (?)`)
    .run(entry.id);
}

const BASE_ENTRY: Omit<MemoryEntry, "id" | "content"> = {
  layer: "working",
  contentType: "message",
  sourceId: "src-1",
  sourceTable: "messages",
  conversationId: null,
  granularity: "fine",
  metadata: null,
  createdAt: "2026-07-16T00:00:00Z",
};

describe("SearchMemory - progressive disclosure", () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;
  let searchMemory: SearchMemory;
  let manageMemory: ManageMemory;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteMemoryRepository(db);
    const searchEngine = new SearchEngine({ rrfK: 60, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(repo, mockEmbeddingGateway(), searchEngine, mockLogger());
    manageMemory = new ManageMemory(repo);

    /** 存入测试数据 */
    storeEntry(db, { ...BASE_ENTRY, id: "e1", content: "用户询问了关于记忆系统的渐进式披露设计原则" });
    storeEntry(db, { ...BASE_ENTRY, id: "e2", content: "今天讨论了 FTS5 的 highlight 函数用法，它可以返回匹配关键词周围的文本" });
    storeEntry(db, { ...BASE_ENTRY, id: "e3", content: "这是一条完全不相关的内容，关于烹饪食谱和食材准备" });
  });

  it("detail_level=snippet 返回匹配片段（默认行为）", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 5 });

    expect(result.entries.length).toBeGreaterThan(0);
    /** snippet 模式应返回 snippet 字段 */
    const first = result.entries[0];
    expect(first.snippet).toBeDefined();
    /** snippet 应包含高亮标记 */
    expect(first.snippet).toContain("<b>");
  });

  it("detail_level=summary 返回首句", async () => {
    const result = await searchMemory.search({ query: "FTS5", limit: 5, detailLevel: "summary" });

    expect(result.entries.length).toBeGreaterThan(0);
    const first = result.entries[0];
    expect(first.snippet).toBeDefined();
    /** summary 应比 snippet 更短 */
    const snippetResult = await searchMemory.search({ query: "FTS5", limit: 5, detailLevel: "snippet" });
    if (snippetResult.entries.length > 0) {
      expect(first.snippet!.length).toBeLessThanOrEqual(snippetResult.entries[0].snippet!.length);
    }
  });

  it("detail_level=full 返回完整内容", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 5, detailLevel: "full" });

    expect(result.entries.length).toBeGreaterThan(0);
    const first = result.entries[0];
    /** full 模式不应返回 snippet 字段 */
    expect(first.snippet).toBeUndefined();
    /** 应返回完整 content */
    expect(first.content).toContain("记忆系统");
  });

  it("FTS5 highlight 在 snippet 模式下生成匹配标记", async () => {
    const result = await searchMemory.search({ query: "渐进式", limit: 5, detailLevel: "snippet" });

    expect(result.entries.length).toBeGreaterThan(0);
    /** highlight 应该用 <b> 标记匹配的关键词 */
    const first = result.entries[0];
    expect(first.snippet).toContain("<b>");
    expect(first.snippet).toContain("</b>");
  });

  it("snippet 降级：vec-only 结果截取前 200 字符", async () => {
    /** 构造 vec-only 场景：FTS 不命中，vec 命中 */
    const longContent = "A".repeat(500) + "关键词在此处出现";
    const longEntry: MemoryEntry = { ...BASE_ENTRY, id: "e-long", content: longContent };

    /** mock repo：FTS 返回空，vec 返回 longEntry */
    const mockRepo = {
      hasVecTable: () => true,
      searchFTSWithHighlight: async () => [],
      searchFTS: async () => [],
      searchVec: async () => [{ entryId: "e-long", distance: 0.1, entry: longEntry }],
      getWeights: async () => [{ memoryEntryId: "e-long", retrievalCount: 0, lastRetrievedAt: null, userFlagged: false }],
      getById: async () => null,
      getEmbedding: async () => null,
      getDetails: async () => [],
      storeEntry: async () => {},
      storeEmbedding: async () => {},
      incrementRetrievalCounts: async () => {},
      flagMemory: async () => {},
      updateLayerByConversation: async () => {},
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };

    const searchEngine = new SearchEngine({ rrfK: 60, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const vecOnlySearch = new SearchMemory(mockRepo, mockEmbedding, searchEngine, mockLogger());

    const result = await vecOnlySearch.search({ query: "关键词", limit: 5, detailLevel: "snippet" });
    expect(result.entries.length).toBe(1);
    const first = result.entries[0];
    expect(first.id).toBe("e-long");
    /** vec-only 降级：应截取 content 前 200 字符，无 <b> 高亮标记 */
    expect(first.snippet).toBeDefined();
    expect(first.snippet!.length).toBeLessThanOrEqual(200);
    expect(first.snippet).not.toContain("<b>");
  });

  it("向后兼容：不传 detail_level 时默认使用 snippet", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 5 });

    expect(result.entries.length).toBeGreaterThan(0);
    /** 默认行为应返回 snippet */
    expect(result.entries[0].snippet).toBeDefined();
  });

  it("ManageMemory.getDetails 返回指定条目的完整内容", async () => {
    const entries = await manageMemory.getDetails(["e1", "e2"]);

    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.id === "e1")?.content).toContain("记忆系统");
    expect(entries.find((e) => e.id === "e2")?.content).toContain("FTS5");
  });

  it("ManageMemory.getDetails 空 ID 列表返回空数组", async () => {
    const entries = await manageMemory.getDetails([]);
    expect(entries).toEqual([]);
  });

  it("ManageMemory.getDetails 不存在的 ID 被忽略", async () => {
    const entries = await manageMemory.getDetails(["e1", "nonexistent"]);
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe("e1");
  });

  it("ManageMemory.getDetails 超过批量上限抛出错误", async () => {
    const tooManyIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    await expect(manageMemory.getDetails(tooManyIds)).rejects.toThrow(/exceeds limit/);
  });
});
