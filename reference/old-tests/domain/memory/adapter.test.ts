import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import DatabaseConstructor from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { MemoryRepository } from "@domain/memory/_internal/repository";
import { SearchEngine, type SearchEngineConfig } from "@domain/memory/_internal/search-engine";
import { MemoryAdapter } from "@domain/memory/_internal/adapter";
import type { EmbeddingService } from "@infra/embedding/service";
import type { MemoryPort } from "@domain/memory/port";
import type { MemoryEntryInput } from "@domain/memory/model";

const sqliteVecAvailable = (() => {
  try {
    const testDb = new DatabaseConstructor(":memory:");
    loadSqliteVec(testDb);
    testDb.close();
    return true;
  } catch {
    return false;
  }
})();

const testConfig: SearchEngineConfig = {
  rrfK: 60,
  weightHalfLifeDays: 7,
  samePathBoost: 1.5,
  crossPathDecay: 0.8,
  userFlagMultiplier: 2.0,
  frequencyBoostFactor: 0.1,
};

/** 创建 mock EmbeddingService，可控制返回值 */
function createMockEmbedding(): EmbeddingService & {
  setNextResult: (result: Float32Array | Error) => void;
  embedCalled: boolean;
} {
  let nextResult: Float32Array | Error = new Float32Array(1024);
  return {
    embedCalled: false,
    setNextResult(result: Float32Array | Error) {
      nextResult = result;
    },
    async embed(text: string): Promise<Float32Array> {
      void text;
      this.embedCalled = true;
      if (nextResult instanceof Error) throw nextResult;
      return nextResult;
    },
    dispose() {},
  };
}

function makeEntry(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    layer: "working",
    contentType: "message",
    sourceId: "msg-1",
    sourceTable: "messages",
    granularity: "fine",
    content: "hello world",
    ...overrides,
  };
}

function insertConversation(db: Database.Database, id: string, treePath = "/conv/1"): void {
  db.prepare(
    "INSERT INTO conversations (id, title, tree_path) VALUES (?, ?, ?)",
  ).run(id, "Test", treePath);
}

/** 刷新微任务队列，让 fire-and-forget embedding 完成 */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("MemoryAdapter", () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  let mockEmbedding: ReturnType<typeof createMockEmbedding>;
  let port: MemoryPort;

  beforeEach(() => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);
    repo = new MemoryRepository(db);
    mockEmbedding = createMockEmbedding();
    const searchEngine = new SearchEngine(testConfig);
    port = new MemoryAdapter(repo, mockEmbedding, searchEngine);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe("store", () => {
    it("返回有效 UUID 并写入条目", async () => {
      const id = await port.store(makeEntry({ content: "test content" }));

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const entry = await port.getById(id);
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe("test content");
    });

    it("触发 embedding.embed 调用", async () => {
      await port.store(makeEntry());
      expect(mockEmbedding.embedCalled).toBe(true);
    });

    it("embedding 成功后异步写入 memory_vec", async () => {
      const id = await port.store(makeEntry());
      await flushMicrotasks();

      const emb = await port.getEmbedding(id);
      if (repo.hasVecTable()) {
        expect(emb).not.toBeNull();
        expect(emb!.length).toBe(1024);
      }
    });

    it("embedding 失败时不抛出异常（D22 写入侧降级）", async () => {
      mockEmbedding.setNextResult(new Error("model load failed"));

      const id = await port.store(makeEntry({ content: "test" }));

      expect(id).toBeTruthy();
      const entry = await port.getById(id);
      expect(entry).not.toBeNull();
    });

    it("getBySource 按来源查询", async () => {
      await port.store(makeEntry({ sourceTable: "messages", sourceId: "msg-42" }));

      const entry = await port.getBySource("messages", "msg-42");
      expect(entry).not.toBeNull();
    });
  });

  describe("search - FTS5 基线", () => {
    it("FTS5 关键词检索返回匹配条目", async () => {
      await port.store(makeEntry({ content: "hello world" }));
      await port.store(makeEntry({ content: "goodbye sky", sourceId: "msg-2" }));
      await flushMicrotasks();

      /** 禁用 vec0 搜索，仅测试 FTS5 */
      mockEmbedding.setNextResult(new Error("FTS5 only"));

      const result = await port.search({ query: "hello" });

      expect(result.entries.length).toBe(1);
      expect(result.entries[0].content).toBe("hello world");
      expect(result.scores.length).toBe(1);
      expect(result.sources.length).toBe(1);
    });

    it("检索后递增 retrieval_count", async () => {
      const id = await port.store(makeEntry({ content: "searchable text" }));

      await port.search({ query: "searchable" });

      const weight = await port.getWeight(id);
      expect(weight.retrievalCount).toBe(1);
    });

    it("conversationId 过滤只返回指定对话的记忆", async () => {
      insertConversation(db, "conv-1");
      insertConversation(db, "conv-2", "/conv/2");

      await port.store(makeEntry({ content: "shared query", conversationId: "conv-1" }));
      await port.store(makeEntry({ content: "shared query", conversationId: "conv-2", sourceId: "msg-2" }));

      const result = await port.search({ query: "shared", conversationId: "conv-1" });

      expect(result.entries.length).toBe(1);
      expect(result.entries[0].conversationId).toBe("conv-1");
    });
  });

  describe("search - 降级", () => {
    it("embedding 失败时降级为纯 FTS5（D22 检索侧）", async () => {
      await port.store(makeEntry({ content: "fallback test" }));

      mockEmbedding.setNextResult(new Error("search embed failed"));
      mockEmbedding.embedCalled = false;

      const result = await port.search({ query: "fallback" });

      expect(result.entries.length).toBe(1);
      expect(result.entries[0].content).toBe("fallback test");
    });
  });

  describe("search - treePath 影响排序", () => {
    it("同路径条目排在前面", async () => {
      insertConversation(db, "conv-1", "/conv/1");
      insertConversation(db, "conv-2", "/conv/2");

      await port.store(makeEntry({
        content: "same query text", conversationId: "conv-1", treePath: "/conv/1",
      }));
      await port.store(makeEntry({
        content: "same query text", conversationId: "conv-2", treePath: "/conv/2", sourceId: "msg-2",
      }));

      /** 同路径搜索 */
      const result = await port.search({ query: "same query", treePath: "/conv/1" });

      expect(result.entries[0].treePath).toBe("/conv/1");
    });
  });

  describe("search - 权重重排", () => {
    it("user_flagged 条目排名更高", async () => {
      const idA = await port.store(makeEntry({ content: "rank test", sourceId: "a" }));
      await port.store(makeEntry({ content: "rank test", sourceId: "b" }));

      /** 标记 A 为重要 */
      await port.flagMemory(idA, true);

      const result = await port.search({ query: "rank" });

      expect(result.entries[0].id).toBe(idA);
    });

    it("高 retrieval_count 条目排名更高", async () => {
      const idA = await port.store(makeEntry({ content: "freq test", sourceId: "a" }));
      await port.store(makeEntry({ content: "freq test", sourceId: "b" }));

      /** 多次检索 A */
      for (let i = 0; i < 10; i++) {
        await port.incrementRetrievalCount(idA);
      }

      const result = await port.search({ query: "freq" });

      expect(result.entries[0].id).toBe(idA);
    });
  });

  describe.skipIf(!sqliteVecAvailable)("search - vec0 全流程", () => {
    it("FTS5 + vec0 全流程返回结果", async () => {
      await port.store(makeEntry({ content: "semantic search test" }));
      await flushMicrotasks();

      const result = await port.search({ query: "semantic" });

      expect(result.entries.length).toBeGreaterThan(0);
    });
  });

  describe("searchSimilar", () => {
    it("无 embedding 时返回空结果", async () => {
      mockEmbedding.setNextResult(new Error("no embedding"));
      const id = await port.store(makeEntry());
      await flushMicrotasks();

      const result = await port.searchSimilar(id, 10);

      expect(result.entries).toEqual([]);
      expect(result.scores).toEqual([]);
      expect(result.sources).toEqual([]);
    });

    it.skipIf(!sqliteVecAvailable)("有 embedding 时返回相似条目", async () => {
      const id = await port.store(makeEntry({ content: "similar test" }));
      await port.store(makeEntry({ content: "similar test two", sourceId: "msg-2" }));
      await flushMicrotasks();

      const result = await port.searchSimilar(id, 10);

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.every(e => e.id !== id)).toBe(true);
    });
  });

  describe("updateLayerByConversation", () => {
    it("批量更新 layer working -> historical", async () => {
      insertConversation(db, "conv-1");

      const id = await port.store(makeEntry({
        conversationId: "conv-1", layer: "working",
      }));

      await port.updateLayerByConversation("conv-1", "working", "historical");

      const entry = await port.getById(id);
      expect(entry!.layer).toBe("historical");
    });
  });

  describe("权重管理", () => {
    it("getWeight 返回默认值", async () => {
      const id = await port.store(makeEntry());

      const weight = await port.getWeight(id);
      expect(weight.retrievalCount).toBe(0);
      expect(weight.userFlagged).toBe(false);
    });

    it("flagMemory 标记和取消标记", async () => {
      const id = await port.store(makeEntry());

      await port.flagMemory(id, true);
      expect((await port.getWeight(id)).userFlagged).toBe(true);

      await port.flagMemory(id, false);
      expect((await port.getWeight(id)).userFlagged).toBe(false);
    });

    it("incrementRetrievalCount 递增计数", async () => {
      const id = await port.store(makeEntry());

      await port.incrementRetrievalCount(id);
      await port.incrementRetrievalCount(id);

      expect((await port.getWeight(id)).retrievalCount).toBe(2);
    });
  });

  describe("Embedding 管理", () => {
    it.skipIf(!sqliteVecAvailable)("storeEmbedding + getEmbedding", async () => {
      const id = await port.store(makeEntry());
      await flushMicrotasks();

      const embedding = new Float32Array(1024).fill(0.5);
      await port.storeEmbedding(id, embedding);

      const retrieved = await port.getEmbedding(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(1024);
      expect(retrieved![0]).toBeCloseTo(0.5, 5);
    });

    it("getEmbedding 未找到返回 null", async () => {
      expect(await port.getEmbedding("nonexistent")).toBeNull();
    });
  });
});

void vi;
