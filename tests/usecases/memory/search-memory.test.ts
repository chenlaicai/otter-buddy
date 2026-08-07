import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import { ManageMemory } from "@usecases/memory/manage-memory";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { tokenizeWithJieba } from "@frameworks/db/jieba-tokenizer";

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
    entry.id, entry.layer, entry.contentType, entry.sourceId, entry.sourceTable,
    entry.conversationId ?? null, entry.granularity, entry.content,
    entry.metadata ? JSON.stringify(entry.metadata) : null, entry.createdAt,
  );
  db.prepare(`INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)`)
    .run(entry.id, entry.content);
  db.prepare(`INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)`)
    .run(entry.id, tokenizeWithJieba(entry.content));
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
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(repo, mockEmbeddingGateway(), searchEngine, createTestLogger());
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
    /** snippet 应是纯文本，不包含 HTML 标签（高亮渲染在 Web 后端处理） */
    expect(first.snippet).not.toContain("<b>");
    expect(first.snippet).not.toContain("</b>");
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

  it("FTS5 snippet 模式返回纯文本（高亮在 Web 后端处理）", async () => {
    const result = await searchMemory.search({ query: "渐进式", limit: 5, detailLevel: "snippet" });

    expect(result.entries.length).toBeGreaterThan(0);
    /** snippet 应是纯文本，不包含 HTML 标签 */
    const first = result.entries[0];
    expect(first.snippet).not.toContain("<b>");
    expect(first.snippet).not.toContain("</b>");
    /** snippet 模式不返回 content（渐进式披露：snippet 定位 → get_memory_detail 深入） */
    expect(first.content).toBeUndefined();
    /** 应有 snippet 作为替代 */
    expect(first.snippet).toBeDefined();
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
      deleteBySource: async () => {},
      replaceEntryBySource: async () => {},
      replaceEntriesBySource: async () => {},
      deleteBySourceAndType: async () => {},
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };

    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const vecOnlySearch = new SearchMemory(mockRepo, mockEmbedding, searchEngine, createTestLogger());

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

describe("SearchMemory - F20260803fbit 去重与 contentType filter", () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;
  let searchMemory: SearchMemory;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteMemoryRepository(db);
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(repo, mockEmbeddingGateway(), searchEngine, createTestLogger());

    /** 构造同文档的 summary entry + body entry，同 sourceId="F123" */
    const docBase = { layer: "document" as const, sourceId: "F123", sourceTable: "features", conversationId: null, granularity: "coarse" as const, metadata: null, createdAt: "2026-08-03T00:00:00Z" };
    storeEntry(db, { ...docBase, id: "summary-1", contentType: "feature", content: "记忆系统校验链路设计概要" });
    storeEntry(db, { ...docBase, id: "body-1", contentType: "feature_chunk", content: "正文详细描述了记忆系统的校验链路与 BM25 ranking 机制" });
    /** PR审视 B8：F123 的第 2 个 chunk，测多 chunk 命中 boost（multi_hit_count 只统计 chunk） */
    storeEntry(db, { ...docBase, id: "body-1b", contentType: "feature_chunk", content: "记忆系统的 embedding 与向量检索路径补充" });
    /** 另一个文档的 body entry，不同 sourceId */
    storeEntry(db, { ...docBase, id: "body-2", sourceId: "F456", contentType: "feature_chunk", content: "另一文档关于 FTS5 trigram 配置" });
  });

  it("去重：同文档 summary+body 双命中只返回 1 条", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 10, layer: "document", library: "conversation" });
    /** summary-1 和 body-1 都命中"记忆系统"，但同 sourceId=F123，去重后只保留高分者 */
    const f123Entries = result.entries.filter(e => e.sourceId === "F123");
    expect(f123Entries.length).toBe(1);
  });

  it("F20260803chunk: 同源多 chunk 命中注入 multi_hit_count", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 10, layer: "document", library: "conversation" });
    /** summary-1（feature）+ body-1（feature_chunk）都命中"记忆系统"，同 F123，multi_hit_count=2 */
    const f123Entry = result.entries.find(e => e.sourceId === "F123");
    expect(f123Entry).toBeDefined();
    expect(f123Entry?.metadata?.multi_hit_count).toBe(2);
  });

  it("contentType filter：只搜 feature_chunk 排除 summary", async () => {
    const result = await searchMemory.search({
      query: "记忆系统", limit: 10, layer: "document", library: "conversation",
      contentType: ["feature_chunk"],
    });
    /** 只命中 body-1（feature_chunk），不命中 summary-1（feature） */
    const types = result.entries.map(e => e.contentType);
    expect(types).not.toContain("feature");
    expect(types).toContain("feature_chunk");
  });

  it("contentType filter：只搜 feature 排除 body", async () => {
    const result = await searchMemory.search({
      query: "记忆系统", limit: 10, layer: "document", library: "conversation",
      contentType: ["feature"],
    });
    const types = result.entries.map(e => e.contentType);
    expect(types).not.toContain("feature_chunk");
    expect(types).toContain("feature");
  });

  it("F20260803fbit: replaceEntryBySource content_type 过滤--summary 和 body entry 共存", async () => {
    /** 同 sourceId 的 summary entry (feature) + body entry (feature_chunk) 应互不删除 */
    const coBase = { layer: "document" as const, sourceId: "F789", sourceTable: "features", conversationId: null, granularity: "coarse" as const, metadata: null, createdAt: "2026-08-03T00:00:00Z" };
    storeEntry(db, { ...coBase, id: "co-sum-1", contentType: "feature", content: "特征文档概要原始" });
    storeEntry(db, { ...coBase, id: "co-body-1", contentType: "feature_chunk", content: "特征文档正文详情内容" });

    /** replaceEntryBySource 替换 feature entry（新 id=co-sum-2），不应删 feature_chunk */
    await repo.replaceEntryBySource({
      ...coBase, id: "co-sum-2", contentType: "feature", content: "特征文档概要更新版",
    });

    /** 搜"特征文档"应命中 co-body-1（保留）+ co-sum-2（新插），不命中 co-sum-1（已删） */
    const all = await repo.searchFTS("特征文档", { layer: "document" });
    const ids = all.map(h => h.entryId);
    expect(ids).toContain("co-body-1");
    expect(ids).toContain("co-sum-2");
    expect(ids).not.toContain("co-sum-1");
  });
});

describe("SearchMemory - 混合搜索融合策略", () => {
  it("FTS 高质量 + Vec 低质量：FTS 结果应优先", async () => {
    const db = createTestDb();

    // 存入梁山伯相关内容（FTS 会命中），使用不同的 sourceId 避免去重
    storeEntry(db, { ...BASE_ENTRY, id: "e1", sourceId: "src-1", content: "梁山伯与祝英台是中国古代四大爱情故事之一" });
    storeEntry(db, { ...BASE_ENTRY, id: "e2", sourceId: "src-2", content: "梁山伯在草桥亭遇见祝英台" });
    storeEntry(db, { ...BASE_ENTRY, id: "e3", sourceId: "src-3", content: "今天天气很好" }); // 不相关

    // Mock embedding gateway，返回低质量的 vec 结果
    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };

    // Mock repo：FTS 返回高质量结果，vec 返回低质量结果
    const mockRepo = {
      hasVecTable: () => true,
      searchFTSWithHighlight: async () => [
        { entryId: "e1", ftsRank: -10, entry: { ...BASE_ENTRY, id: "e1", sourceId: "src-1", content: "梁山伯与祝英台是中国古代四大爱情故事之一" }, snippet: "梁山伯与祝英台" },
        { entryId: "e2", ftsRank: -8, entry: { ...BASE_ENTRY, id: "e2", sourceId: "src-2", content: "梁山伯在草桥亭遇见祝英台" }, snippet: "梁山伯在草桥亭" },
      ],
      searchFTS: async () => [],
      // Vec 返回低质量结果（distance 很大，similarity 很低）
      searchVec: async () => [
        { entryId: "e3", distance: 0.9, entry: { ...BASE_ENTRY, id: "e3", sourceId: "src-3", content: "今天天气很好" } }, // similarity = 0.1 < 0.3，应被过滤
      ],
      getWeights: async () => [
        { memoryEntryId: "e1", retrievalCount: 0, lastRetrievedAt: null, userFlagged: false },
        { memoryEntryId: "e2", retrievalCount: 0, lastRetrievedAt: null, userFlagged: false },
      ],
      getById: async () => null,
      getEmbedding: async () => null,
      getDetails: async () => [],
      storeEntry: async () => {},
      storeEmbedding: async () => {},
      incrementRetrievalCounts: async () => {},
      flagMemory: async () => {},
      updateLayerByConversation: async () => {},
      deleteBySource: async () => {},
      replaceEntryBySource: async () => {},
      replaceEntriesBySource: async () => {},
      deleteBySourceAndType: async () => {},
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const searchEngine = new SearchEngine({
      rrfK: 60,
      alpha: 0.4,
      vecSimilarityThreshold: 0.3,
      bothBoost: 1.2,
      weightHalfLifeDays: 7,
      userFlagMultiplier: 2,
      frequencyBoostFactor: 0.1,
    });
    const searchMemory = new SearchMemory(mockRepo, mockEmbedding, searchEngine, createTestLogger());

    const result = await searchMemory.search({ query: "梁山伯", limit: 5 });

    // e3 应该被 vecSimilarityThreshold 过滤掉
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].id).toBe("e1");
    expect(result.entries[1].id).toBe("e2");
    // 不应该包含 e3（低质量 vec 结果）
    expect(result.entries.find(e => e.id === "e3")).toBeUndefined();
  });

  it("Vec 高质量结果应保留", async () => {
    const db = createTestDb();

    storeEntry(db, { ...BASE_ENTRY, id: "e1", sourceId: "src-1", content: "梁山伯与祝英台" });
    storeEntry(db, { ...BASE_ENTRY, id: "e2", sourceId: "src-2", content: "梁祝故事" }); // 语义相关但 FTS 不一定命中

    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };

    const mockRepo = {
      hasVecTable: () => true,
      searchFTSWithHighlight: async () => [
        { entryId: "e1", ftsRank: -10, entry: { ...BASE_ENTRY, id: "e1", sourceId: "src-1", content: "梁山伯与祝英台" }, snippet: "梁山伯与祝英台" },
      ],
      searchFTS: async () => [],
      // Vec 返回高质量结果（distance 小，similarity 高）
      searchVec: async () => [
        { entryId: "e1", distance: 0.2, entry: { ...BASE_ENTRY, id: "e1", sourceId: "src-1", content: "梁山伯与祝英台" } }, // similarity = 0.8
        { entryId: "e2", distance: 0.4, entry: { ...BASE_ENTRY, id: "e2", sourceId: "src-2", content: "梁祝故事" } }, // similarity = 0.6
      ],
      getWeights: async () => [
        { memoryEntryId: "e1", retrievalCount: 0, lastRetrievedAt: null, userFlagged: false },
        { memoryEntryId: "e2", retrievalCount: 0, lastRetrievedAt: null, userFlagged: false },
      ],
      getById: async () => null,
      getEmbedding: async () => null,
      getDetails: async () => [],
      storeEntry: async () => {},
      storeEmbedding: async () => {},
      incrementRetrievalCounts: async () => {},
      flagMemory: async () => {},
      updateLayerByConversation: async () => {},
      deleteBySource: async () => {},
      replaceEntryBySource: async () => {},
      replaceEntriesBySource: async () => {},
      deleteBySourceAndType: async () => {},
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const searchEngine = new SearchEngine({
      rrfK: 60,
      alpha: 0.4,
      vecSimilarityThreshold: 0.3,
      bothBoost: 1.2,
      weightHalfLifeDays: 7,
      userFlagMultiplier: 2,
      frequencyBoostFactor: 0.1,
    });
    const searchMemory = new SearchMemory(mockRepo, mockEmbedding, searchEngine, createTestLogger());

    const result = await searchMemory.search({ query: "梁山伯", limit: 5 });

    // e1 和 e2 都应该保留（e2 的 similarity=0.6 >= 0.3）
    expect(result.entries.length).toBe(2);
    expect(result.entries.find(e => e.id === "e1")).toBeDefined();
    expect(result.entries.find(e => e.id === "e2")).toBeDefined();
  });
});
