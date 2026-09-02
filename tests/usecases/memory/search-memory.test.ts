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
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(repo, repo, mockEmbeddingGateway(), searchEngine, createTestLogger());
    manageMemory = new ManageMemory(repo, repo);

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
    /** content 应被裁剪为 snippet，不应包含完整原文 */
    expect(first.content).toBe(first.snippet);
  });

  it("detail_level=summary 返回原文首句（#542：提取源为原文，与匹配位置解耦）", async () => {
    const result = await searchMemory.search({ query: "FTS5", limit: 5, detailLevel: "summary" });

    expect(result.entries.length).toBeGreaterThan(0);
    const first = result.entries[0];
    expect(first.snippet).toBeDefined();
    /**
     * #542 契约：content = 原文首句（开头即有信息量），snippet = FTS 匹配窗口。
     * 两者提取源不同（原文 vs 匹配位置），短文浅匹配时可能恰好重合——
     * 分离的意义在深匹配场景（见下方回归测试），此处断言契约本身：
     */
    expect(first.content.startsWith("今天讨论了")).toBe(true);
    expect(first.snippet).toContain("FTS5");
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
    /** content 应被裁剪为 snippet，不应返回全文 */
    expect(first.content).toBe(first.snippet);
  });

  it("FTS highlight 超长时截断到 200 字符", async () => {
    /** 存入一条 > 200 字符的长内容，确保 FTS highlight 也会很长 */
    const longContent = "关于记忆系统的渐进式披露设计，这是一个非常重要的架构决策。".repeat(10);
    storeEntry(db, { ...BASE_ENTRY, id: "e-long", content: longContent });

    const result = await searchMemory.search({ query: "渐进式披露", limit: 5, detailLevel: "snippet" });
    const longEntry = result.entries.find(e => e.id === "e-long");
    if (longEntry) {
      /** FTS highlight snippet 应被截断到 200 字符 */
      expect(longEntry.snippet!.length).toBeLessThanOrEqual(200);
      expect(longEntry.snippet!.length).toBeGreaterThan(0);
      /** content 也应被裁剪 */
      expect(longEntry.content).toBe(longEntry.snippet);
    }
  });

  it("snippet 降级：vec-only 结果截取前 200 字符", async () => {
    /** 构造 vec-only 场景：FTS 不命中，vec 命中 */
    const longContent = "A".repeat(500) + "关键词在此处出现";
    const longEntry: MemoryEntry = { ...BASE_ENTRY, id: "e-long", content: longContent };

    /** mock repo：FTS 返回空，vec 返回 longEntry */
    const mockRepo = {
      hasVecTable: () => true,
      /* #576: listRecent 不在此测试范围 */
      listRecent: async () => [] as never[],
      isVecEnabled: () => true,
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
      getEmbeddingMeta: async () => ({}),
      setEmbeddingMeta: async () => {},
      scanDarkEntries: async () => ({ entries: [], total: 0, vecDisabled: false }),
      hasEmbeddings: async () => new Map(),
      enqueueRetry: async () => {},
      claimPendingTasks: async () => [],
      markTaskDone: async () => {},
      markTaskAttemptFailed: async () => {},
      getBySourceId: async () => null,
      findNeighborsByChunkIndex: async () => [],
      findNeighborsByTime: async () => [],
      createEdge: async () => "edge-id",
      getEdgesByEntry: async () => [],
      getEdgeById: async () => null,
      deleteEdge: async () => {},
      deleteEdgesByEntryIds: async () => {},
      getEntriesByConversation: async () => [],
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const mockEmbedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };

    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const vecOnlySearch = new SearchMemory(mockRepo, mockRepo, mockEmbedding, searchEngine, createTestLogger());

    const result = await vecOnlySearch.search({ query: "关键词", limit: 5, detailLevel: "snippet" });
    expect(result.entries.length).toBe(1);
    const first = result.entries[0];
    expect(first.id).toBe("e-long");
    /** vec-only 降级：应截取 content 前 200 字符，无 <b> 高亮标记 */
    expect(first.snippet).toBeDefined();
    expect(first.snippet!.length).toBeLessThanOrEqual(200);
    expect(first.snippet).not.toContain("<b>");
    /** content 也应被裁剪，不应返回 500 字全文 */
    expect(first.content).toBe(first.snippet);
    expect(first.content.length).toBeLessThanOrEqual(200);
  });

  it("向后兼容：不传 detail_level 时默认使用 snippet", async () => {
    const result = await searchMemory.search({ query: "记忆系统", limit: 5 });

    expect(result.entries.length).toBeGreaterThan(0);
    /** 默认行为应返回 snippet */
    expect(result.entries[0].snippet).toBeDefined();
    /** content 也应被裁剪（默认 detail_level=snippet） */
    expect(result.entries[0].content).toBe(result.entries[0].snippet);
  });

  it("渐进式披露三模式契约（#542）：summary=原文首句 / snippet=匹配窗口 / full=全文", async () => {
    /** 存入一条长文本条目（句末标点后无数字，首句=第一个句号止） */
    const longContent = "记忆系统的渐进式披露设计原则是一个重要的架构决策。".repeat(30);
    storeEntry(db, { ...BASE_ENTRY, id: "e-long", content: longContent });

    /** snippet 模式：content = snippet = FTS 匹配窗口（不变量保持） */
    const snippetResult = await searchMemory.search({ query: "渐进式披露", limit: 5, detailLevel: "snippet" });
    const snippetEntry = snippetResult.entries.find(e => e.id === "e-long");
    expect(snippetEntry).toBeDefined();
    expect(snippetEntry!.content).toBe(snippetEntry!.snippet);

    /** summary 模式：content = 原文首句（#542：与 FTS 窗口解耦） */
    const summaryResult = await searchMemory.search({ query: "渐进式披露", limit: 5, detailLevel: "summary" });
    const summaryEntry = summaryResult.entries.find(e => e.id === "e-long");
    expect(summaryEntry).toBeDefined();
    expect(summaryEntry!.content).toBe("记忆系统的渐进式披露设计原则是一个重要的架构决策。");
    /** snippet 字段仍是匹配窗口 */
    expect(summaryEntry!.snippet).toBe(snippetEntry!.snippet);

    /** full 模式：content 保持完整原文，无 snippet 字段 */
    const fullResult = await searchMemory.search({ query: "渐进式披露", limit: 5, detailLevel: "full" });
    const fullEntry = fullResult.entries.find(e => e.id === "e-long");
    expect(fullEntry).toBeDefined();
    expect(fullEntry!.content).toBe(longContent);
    expect(fullEntry!.snippet).toBeUndefined();
  });

  it("detail_level 未传时默认 summary：content 为原文首句截断，不返回全文（#542 契约）", async () => {
    /** 存入一条超长条目（无句末标点，首句提取回退到 $ 整段，验证截断兜底） */
    const longContent = "关键词".repeat(300);
    storeEntry(db, { ...BASE_ENTRY, id: "e-long2", content: longContent });

    const result = await searchMemory.search({ query: "关键词", limit: 5 });
    const entry = result.entries.find(e => e.id === "e-long2");
    if (entry) {
      /** 不应返回 900 字全文；summary 首句无终止符时整段截断到 200 */
      expect(entry.content.length).toBeLessThanOrEqual(200);
      expect(entry.content.startsWith("关键词")).toBe(true);
    }
  });

  /**
   * #542 回归锁：summary 模式空 content 投影缺陷。
   * issue 实证（2026-08-28 起，40% 复现）：FTS 深匹配条目（匹配词在 100 字符后）的
   * 匹配窗口带 `...` 前缀，旧首句正则从窗口提取出 `.`；换行开头提取出 `\n`；
   * 编号标题（`2.2 方案`）提取出 `2.`。修复后 content 恒为原文首句（与匹配位置解耦）。
   */
  it("#542 回归：FTS 深匹配条目 summary content 不再投影为 `.`/`\n`（原文首句）", async () => {
    /** 深匹配构造：匹配词埋在 150 字符后，FTS 窗口必带 `...` 前缀（100 窗口半径之外） */
    const filler = "这是与查询无关的铺垫内容，用来把匹配词推到文档深处。";
    const deepContent = filler.repeat(6) + "靶词语在这里。" + "后续还有更多内容用于拉长文档。".repeat(3);
    storeEntry(db, { ...BASE_ENTRY, id: "e-deep", sourceId: "src-deep", content: deepContent });

    const result = await searchMemory.search({ query: "靶词语", limit: 5, detailLevel: "summary" });
    const entry = result.entries.find(e => e.id === "e-deep");
    expect(entry).toBeDefined();
    /** 核心断言（确定性）：content 是原文首句，非空非单字符 */
    expect(entry!.content).toBe("这是与查询无关的铺垫内容，用来把匹配词推到文档深处。");
    expect(entry!.content.length).toBeGreaterThan(10);
    /** snippet 保留 FTS 匹配窗口（含匹配词与省略号） */
    expect(entry!.snippet).toContain("靶词语");
    expect(entry!.snippet!.startsWith("...")).toBe(true);
  });

  it("#542 回归：编号开头/换行开头条目的 summary content 不截断为 `2.`/空行", async () => {
    /** 编号标题开头（issue 样本 `2.2 方案` → 旧投影 `2.`）。独立 sourceId：dedup 按 source 折叠，
     *  共用 src-1 时同组其他条目（含"行"字）会挤掉本条 */
    storeEntry(db, { ...BASE_ENTRY, id: "e-num", sourceId: "src-num", content: "2.2 方案设计要点\n正文第一行。第二行继续。" });
    const r1 = await searchMemory.search({ query: "方案设计要点", limit: 5, detailLevel: "summary" });
    const e1 = r1.entries.find(e => e.id === "e-num");
    expect(e1).toBeDefined();
    expect(e1!.content).toBe("2.2 方案设计要点");
    expect(e1!.content).not.toBe("2.");

    /** 空行开头（issue 样本 → 旧投影 `\n`）。独立 sourceId 同上 */
    storeEntry(db, { ...BASE_ENTRY, id: "e-nl", sourceId: "src-nl", content: "\n换行开头条目的首行内容。第二行。" });
    const r2 = await searchMemory.search({ query: "换行开头", limit: 5, detailLevel: "summary" });
    const e2 = r2.entries.find(e => e.id === "e-nl");
    expect(e2).toBeDefined();
    expect(e2!.content).toBe("换行开头条目的首行内容。");
    expect(e2!.content).not.toBe("\n");
  });

  it("#542 回归：同 entry 双查询（summary vs snippet）content 均非空且含原文信息", async () => {
    /** issue 验收标准：双查询路径同 entry 结果一致可用（DB 有内容则两模式都拿得到） */
    /** 深匹配（匹配词埋在 150+ 字符后，FTS 窗口带 `...` 前缀）：旧代码此场景
     *  summary 投影 `.` 而 snippet 正常——正是 issue 双查询对照实证的分歧形态 */
    const deepContent = "深埋条目的开头句子，信息量从这里起步。" + "中段铺垫内容用于把关键词推到窗口之外。".repeat(8) + "定位关键词在中部。" + "尾部内容。".repeat(20);
    storeEntry(db, { ...BASE_ENTRY, id: "e-dual", sourceId: "src-dual", content: deepContent });

    const summary = await searchMemory.search({ query: "定位关键词", limit: 5, detailLevel: "summary" });
    const snippet = await searchMemory.search({ query: "定位关键词", limit: 5, detailLevel: "snippet" });
    const s1 = summary.entries.find(e => e.id === "e-dual");
    const s2 = snippet.entries.find(e => e.id === "e-dual");
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    /** 两模式 content 均非空、非单字符（`./\n` 判定，对应 issue 40% 空投影） */
    for (const e of [s1, s2]) {
      expect(e!.content.length).toBeGreaterThan(5);
      expect(e!.content).not.toBe(".");
      expect(e!.content).not.toBe("\n");
    }
    /** summary content 恒为原文首句（确定性锚点，与匹配位置无关） */
    expect(s1!.content).toBe("深埋条目的开头句子，信息量从这里起步。");
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
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    searchMemory = new SearchMemory(repo, repo, mockEmbeddingGateway(), searchEngine, createTestLogger());

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
      /* #576: listRecent 不在此测试范围 */
      listRecent: async () => [] as never[],
      isVecEnabled: () => true,
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
      getEmbeddingMeta: async () => ({}),
      setEmbeddingMeta: async () => {},
      scanDarkEntries: async () => ({ entries: [], total: 0, vecDisabled: false }),
      hasEmbeddings: async () => new Map(),
      enqueueRetry: async () => {},
      claimPendingTasks: async () => [],
      markTaskDone: async () => {},
      markTaskAttemptFailed: async () => {},
      getBySourceId: async () => null,
      findNeighborsByChunkIndex: async () => [],
      findNeighborsByTime: async () => [],
      createEdge: async () => "edge-id",
      getEdgesByEntry: async () => [],
      getEdgeById: async () => null,
      deleteEdge: async () => {},
      deleteEdgesByEntryIds: async () => {},
      getEntriesByConversation: async () => [],
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const searchEngine = new SearchEngine({
      rrfK: 60,
      alpha: 0.4,
      vecSimilarityThreshold: 0.3,
      bothBoost: 1.2,
      weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90,
      userFlagMultiplier: 2,
      frequencyBoostFactor: 0.1,
    });
    const searchMemory = new SearchMemory(mockRepo, mockRepo, mockEmbedding, searchEngine, createTestLogger());

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
      /* #576: listRecent 不在此测试范围 */
      listRecent: async () => [] as never[],
      isVecEnabled: () => true,
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
      getEmbeddingMeta: async () => ({}),
      setEmbeddingMeta: async () => {},
      scanDarkEntries: async () => ({ entries: [], total: 0, vecDisabled: false }),
      hasEmbeddings: async () => new Map(),
      enqueueRetry: async () => {},
      claimPendingTasks: async () => [],
      markTaskDone: async () => {},
      markTaskAttemptFailed: async () => {},
      getBySourceId: async () => null,
      findNeighborsByChunkIndex: async () => [],
      findNeighborsByTime: async () => [],
      createEdge: async () => "edge-id",
      getEdgesByEntry: async () => [],
      getEdgeById: async () => null,
      deleteEdge: async () => {},
      deleteEdgesByEntryIds: async () => {},
      getEntriesByConversation: async () => [],
    } satisfies import("@usecases/memory/memory-repository").MemoryRepository;

    const searchEngine = new SearchEngine({
      rrfK: 60,
      alpha: 0.4,
      vecSimilarityThreshold: 0.3,
      bothBoost: 1.2,
      weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90,
      userFlagMultiplier: 2,
      frequencyBoostFactor: 0.1,
    });
    const searchMemory = new SearchMemory(mockRepo, mockRepo, mockEmbedding, searchEngine, createTestLogger());

    const result = await searchMemory.search({ query: "梁山伯", limit: 5 });

    // e1 和 e2 都应该保留（e2 的 similarity=0.6 >= 0.3）
    expect(result.entries.length).toBe(2);
    expect(result.entries.find(e => e.id === "e1")).toBeDefined();
    expect(result.entries.find(e => e.id === "e2")).toBeDefined();
  });
});

describe("SearchMemory - F20260812mrcq Part 3 anchor 短路", () => {
  it("P3-AT-1: 纯 F ID 短路，命中顶格 source=anchor", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const embedding: EmbeddingGateway = {
      available: true,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    };
    // 灌一条 F 文档 summary（审视二轮 M1: await 防 fire-and-forget 竞态）
    await repo.storeEntry({
      id: "anchor-1", layer: "document", contentType: "feature",
      sourceId: "F20260812mrcq", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "F20260812mrcq summary content about memory recall quality",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });
    await repo.storeEmbedding("anchor-1", new Float32Array([0.1, 0.2, 0.3]));

    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "F20260812mrcq",
      limit: 5,
      detailLevel: "summary",
    });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].source).toBe("anchor");
    expect(result.entries[0].sourceId).toBe("F20260812mrcq");
  });

  it("P3-AT-3: ID + 其他词，anchor 短路 + 剩余走 RRF", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    await repo.storeEntry({
      id: "anchor-2", layer: "document", contentType: "feature",
      sourceId: "F20260812mrcq", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "F20260812mrcq summary",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });
    // 灌另一条会被 RRF 命中的 message（无 conversation_id 避免 FK 约束）
    await repo.storeEntry({
      id: "msg-1", layer: "working", contentType: "message",
      sourceId: "m1", sourceTable: "messages",
      conversationId: null, granularity: "fine",
      content: "讨论召回优化的方案",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });

    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "F20260812mrcq 召回优化",
      limit: 5,
      detailLevel: "summary",
    });
    // 第一条是 anchor
    expect(result.entries[0].source).toBe("anchor");
    expect(result.entries[0].sourceId).toBe("F20260812mrcq");
    // 应该还有 RRF 命中的"召回优化"结果
    expect(result.total).toBeGreaterThan(1);
  });

  it("P3-AT-4: ID 不存在 → anchor 不短路，走 RRF", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };

    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "F20999999zzzz",
      limit: 5,
      detailLevel: "summary",
    });
    // anchor 不命中（ID 不存在），FTS 也找不到 → 空结果
    expect(result.entries.length).toBe(0);
    expect(result.total).toBe(0);
  });

  it("P3-AT-6: 词边界——F20260812mrcqextra 不短路", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await repo.storeEntry({
      id: "anchor-3", layer: "document", contentType: "feature",
      sourceId: "F20260812mrcq", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "summary",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "F20260812mrcqextra",
      limit: 5,
      detailLevel: "summary",
    });
    // 词边界不匹配，不短路（也不命中 FTS）
    expect(result.entries.find(e => e.source === "anchor")).toBeUndefined();
  });

  it("P3-AT-8: library=terminology 跳过 anchor 短路", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await repo.storeEntry({
      id: "anchor-4", layer: "document", contentType: "feature",
      sourceId: "F20260812mrcq", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "summary",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "F20260812mrcq",
      limit: 5,
      detailLevel: "summary",
      library: "terminology",
    });
    // terminology 库不短路（术语库无 F/R ID）
    expect(result.entries.find(e => e.source === "anchor")).toBeUndefined();
  });

  it("P3-AT-7: URL 编码兜底（%20 空格）", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await repo.storeEntry({
      id: "anchor-5", layer: "document", contentType: "feature",
      sourceId: "F20260812mrcq", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "summary",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    // URL 编码的空格
    const result = await search.search({
      query: "F20260812mrcq%20召回",
      limit: 5,
      detailLevel: "summary",
    });
    expect(result.entries[0].source).toBe("anchor");
    expect(result.entries[0].sourceId).toBe("F20260812mrcq");
  });
});

describe("SearchMemory - F20260812mrcq Part 2 context-expand", () => {
  async function insertChunk(repo: SqliteMemoryRepository, id: string, sourceId: string, chunkIndex: number, content: string): Promise<void> {
    await repo.storeEntry({
      id, layer: "document", contentType: "feature_chunk",
      sourceId, sourceTable: "features",
      conversationId: null, granularity: "fine",
      content,
      metadata: { chunk_index: chunkIndex, chunk_total: 5, heading_path: ["test"] },
      createdAt: `2026-08-12T00:00:0${chunkIndex}Z`,
    });
  }

  it("P2-AT-1: chunk 命中后扩展 ±1 邻域", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await insertChunk(repo, "c0", "F1", 0, "intro");
    await insertChunk(repo, "c1", "F1", 1, "first section about RRF");
    await insertChunk(repo, "c2", "F1", 2, "weights rerank");
    await insertChunk(repo, "c3", "F1", 3, "frequency boost");
    await insertChunk(repo, "c4", "F1", 4, "conclusion");

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "weights rerank",
      limit: 5,
      detailLevel: "snippet",
      expandContext: true,
      contentType: ["feature_chunk"],
    });
    // 命中 c2
    const hit = result.entries.find(e => e.id === "c2");
    expect(hit).toBeDefined();
    // contextEntries 应含 c1 和 c3
    expect(result.contextEntries).toBeDefined();
    const ctxIds = result.contextEntries!.map(e => e.id);
    expect(ctxIds).toContain("c1");
    expect(ctxIds).toContain("c3");
    // 不应含 c0 / c4（非邻域）或 c2（命中本身）
    expect(ctxIds).not.toContain("c0");
    expect(ctxIds).not.toContain("c4");
    expect(ctxIds).not.toContain("c2");
    // 所有 contextEntries source = context-expand
    for (const ctx of result.contextEntries!) {
      expect(ctx.source).toBe("context-expand");
    }
  });

  it("P2-AT-3: chunk_index=0 边界——只向后扩展", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await insertChunk(repo, "c0", "F2", 0, "intro");
    await insertChunk(repo, "c1", "F2", 1, "section two");
    await insertChunk(repo, "c2", "F2", 2, "section three");

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "intro",
      limit: 5,
      detailLevel: "snippet",
      expandContext: true,
      contentType: ["feature_chunk"],
    });
    expect(result.entries.find(e => e.id === "c0")).toBeDefined();
    const ctxIds = result.contextEntries?.map(e => e.id) ?? [];
    expect(ctxIds).toContain("c1");  // 向后扩展
    expect(ctxIds).not.toContain("c-1");  // 不可能存在
  });

  it("P2-AT-4: summary 命中 no-op", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await repo.storeEntry({
      id: "s1", layer: "document", contentType: "feature",
      sourceId: "F3", sourceTable: "features",
      conversationId: null, granularity: "coarse",
      content: "F3 summary about anchor and context",
      metadata: null, createdAt: "2026-08-12T00:00:00Z",
    });

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "anchor",
      limit: 5,
      detailLevel: "snippet",
      expandContext: true,
      contentType: ["feature"],
    });
    expect(result.entries.length).toBe(1);
    // summary 无邻域结构，contextEntries 为空或未定义
    expect(result.contextEntries ?? []).toHaveLength(0);
  });

  it("P2-AT-5: 默认不扩展（不传 expandContext）", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await insertChunk(repo, "c0", "F4", 0, "intro");
    await insertChunk(repo, "c1", "F4", 1, "second");

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "intro",
      limit: 5,
      detailLevel: "snippet",
      contentType: ["feature_chunk"],
      // 不传 expandContext
    });
    expect(result.contextEntries).toBeUndefined();
  });

  it("P2-AT-2: message 命中后扩展前后各一条", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    // 灌同一 conversation 的 5 条 message（无 conversation FK：用 null conv + 手动指定同一 conversationId 不行
    // 改用直接插 conversations 行 + memory_entries 引用）
    db.prepare(`
      INSERT INTO conversations (id, title, status, created_at, updated_at)
      VALUES ('conv-msg', 'test', 'active', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
    `).run();
    for (let i = 0; i < 5; i++) {
      await repo.storeEntry({
        id: `m${i}`, layer: "working", contentType: "message",
        sourceId: `m${i}`, sourceTable: "messages",
        conversationId: "conv-msg", granularity: "fine",
        content: i === 2 ? "weights rerank formula" : `message ${i} content`,
        metadata: null,
        createdAt: `2026-08-12T00:00:0${i}Z`,
      });
    }

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "weights rerank",
      limit: 5,
      detailLevel: "snippet",
      expandContext: true,
      contentType: ["message"],
    });
    // 命中 m2
    expect(result.entries.find(e => e.id === "m2")).toBeDefined();
    // contextEntries 应含 m1 和 m3
    expect(result.contextEntries).toBeDefined();
    const ctxIds = result.contextEntries!.map(e => e.id);
    expect(ctxIds).toContain("m1");
    expect(ctxIds).toContain("m3");
    // 不应含 m0 / m4（非邻域）或 m2（命中本身）
    expect(ctxIds).not.toContain("m0");
    expect(ctxIds).not.toContain("m4");
    expect(ctxIds).not.toContain("m2");
  });

  it("P2-AT-7: full 模式不扩展", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    await insertChunk(repo, "c0", "F5", 0, "intro");
    await insertChunk(repo, "c1", "F5", 1, "second");

    const embedding: EmbeddingGateway = {
      available: false,
      embed: async () => { throw new Error("mock"); },
    };
    const searchEngine = new SearchEngine({ rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2, weightHalfLifeDays: 7, weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1 });
    const search = new SearchMemory(repo, repo, embedding, searchEngine, createTestLogger());

    const result = await search.search({
      query: "intro",
      limit: 5,
      detailLevel: "full",
      expandContext: true,
      contentType: ["feature_chunk"],
    });
    expect(result.contextEntries).toBeUndefined();
  });
});
