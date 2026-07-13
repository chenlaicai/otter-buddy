import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { MemoryRepository } from "@domain/memory/_internal/repository";
import type { MemoryEntryInput } from "@domain/memory/model";

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

describe("MemoryRepository", () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = initDatabase({ dbPath: ":memory:" });
    initSchema(db);
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe("storeEntry + getById", () => {
    it("创建后可按 ID 查询", () => {
      repo.storeEntry("mem-1", makeEntry({ content: "test content" }));

      const entry = repo.getById("mem-1")!;
      expect(entry.id).toBe("mem-1");
      expect(entry.content).toBe("test content");
      expect(entry.layer).toBe("working");
      expect(entry.contentType).toBe("message");
      expect(entry.granularity).toBe("fine");
      expect(entry.createdAt).toBeTruthy();
    });

    it("getById 未找到返回 null", () => {
      expect(repo.getById("nonexistent")).toBeNull();
    });

    it("storeEntry 写入 memory_entries + memory_fts + memory_weights（单事务）", () => {
      repo.storeEntry("mem-1", makeEntry());

      expect(repo.getById("mem-1")).not.toBeNull();

      const ftsHits = repo.searchFTS("hello", { limit: 10 });
      expect(ftsHits.length).toBe(1);
      expect(ftsHits[0].memoryEntryId).toBe("mem-1");

      const weight = repo.getWeight("mem-1");
      expect(weight.retrievalCount).toBe(0);
      expect(weight.userFlagged).toBe(false);
      expect(weight.lastRetrievedAt).toBeNull();
    });
  });

  describe("storeEntry + getBySource", () => {
    it("按来源表 + ID 查询", () => {
      repo.storeEntry("mem-1", makeEntry({ sourceTable: "messages", sourceId: "msg-42" }));

      const entry = repo.getBySource("messages", "msg-42")!;
      expect(entry.id).toBe("mem-1");
    });

    it("getBySource 未找到返回 null", () => {
      expect(repo.getBySource("messages", "nonexistent")).toBeNull();
    });
  });

  describe("storeEntry + metadata JSON", () => {
    it("metadata 正确序列化和反序列化", () => {
      const metadata = { tags: ["important", "todo"], priority: 5 };
      repo.storeEntry("mem-1", makeEntry({ metadata }));

      const entry = repo.getById("mem-1")!;
      expect(entry.metadata).toEqual(metadata);
    });

    it("metadata 为 null 时不报错", () => {
      repo.storeEntry("mem-1", makeEntry({ metadata: undefined }));

      const entry = repo.getById("mem-1")!;
      expect(entry.metadata).toBeNull();
    });
  });

  describe("searchFTS", () => {
    it("FTS5 可检索到刚写入的条目", () => {
      repo.storeEntry("mem-1", makeEntry({ content: "hello world" }));
      repo.storeEntry("mem-2", makeEntry({ content: "goodbye world", sourceId: "msg-2" }));

      const hits = repo.searchFTS("hello", { limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].memoryEntryId).toBe("mem-1");
    });

    it("trigram 分词对中文有效", () => {
      repo.storeEntry("mem-1", makeEntry({ content: "今天天气很好适合出去玩" }));
      repo.storeEntry("mem-2", makeEntry({ content: "明天可能下雨", sourceId: "msg-2" }));

      /** trigram 需要 3+ 字符，"天气很" 是 "今天天气很好" 的 trigram */
      const hits = repo.searchFTS("天气很", { limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].memoryEntryId).toBe("mem-1");
    });

    it("layer 过滤只返回指定 layer", () => {
      repo.storeEntry("mem-1", makeEntry({ layer: "working", content: "test query" }));
      repo.storeEntry("mem-2", makeEntry({ layer: "historical", content: "test query", sourceId: "msg-2" }));

      const hits = repo.searchFTS("test", { layer: "working", limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].entry.layer).toBe("working");
    });

    it("granularity 过滤只返回指定 granularity", () => {
      repo.storeEntry("mem-1", makeEntry({ granularity: "fine", content: "test query" }));
      repo.storeEntry("mem-2", makeEntry({ granularity: "coarse", content: "test query", sourceId: "msg-2" }));

      const hits = repo.searchFTS("test", { granularity: "fine", limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].entry.granularity).toBe("fine");
    });

    it("conversationId 过滤只返回指定对话", () => {
      insertConversation(db, "conv-1");
      insertConversation(db, "conv-2", "/conv/2");

      repo.storeEntry("mem-1", makeEntry({ content: "test query", conversationId: "conv-1" }));
      repo.storeEntry("mem-2", makeEntry({ content: "test query", conversationId: "conv-2", sourceId: "msg-2" }));

      const hits = repo.searchFTS("test", { conversationId: "conv-1", limit: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0].entry.conversationId).toBe("conv-1");
    });
  });

  describe("权重操作", () => {
    it("getWeight 返回默认值", () => {
      repo.storeEntry("mem-1", makeEntry());

      const weight = repo.getWeight("mem-1");
      expect(weight.retrievalCount).toBe(0);
      expect(weight.userFlagged).toBe(false);
      expect(weight.lastRetrievedAt).toBeNull();
    });

    it("getWeight 未找到时抛出异常", () => {
      expect(() => repo.getWeight("nonexistent")).toThrow(/not found/);
    });

    it("getWeights 批量查询", () => {
      repo.storeEntry("mem-1", makeEntry());
      repo.storeEntry("mem-2", makeEntry({ sourceId: "msg-2" }));
      repo.storeEntry("mem-3", makeEntry({ sourceId: "msg-3" }));

      const weights = repo.getWeights(["mem-1", "mem-2", "nonexistent"]);
      expect(weights.size).toBe(2);
      expect(weights.has("mem-1")).toBe(true);
      expect(weights.has("mem-2")).toBe(true);
      expect(weights.has("nonexistent")).toBe(false);
    });

    it("getWeights 空数组返回空 Map", () => {
      expect(repo.getWeights([]).size).toBe(0);
    });

    it("incrementRetrievalCount 计数递增 + 时间更新", () => {
      repo.storeEntry("mem-1", makeEntry());

      repo.incrementRetrievalCount("mem-1");
      let weight = repo.getWeight("mem-1");
      expect(weight.retrievalCount).toBe(1);
      expect(weight.lastRetrievedAt).not.toBeNull();

      repo.incrementRetrievalCount("mem-1");
      weight = repo.getWeight("mem-1");
      expect(weight.retrievalCount).toBe(2);
    });

    it("incrementRetrievalCounts 批量递增", () => {
      repo.storeEntry("mem-1", makeEntry());
      repo.storeEntry("mem-2", makeEntry({ sourceId: "msg-2" }));

      repo.incrementRetrievalCounts(["mem-1", "mem-2"]);

      expect(repo.getWeight("mem-1").retrievalCount).toBe(1);
      expect(repo.getWeight("mem-2").retrievalCount).toBe(1);
    });

    it("incrementRetrievalCounts 空数组不报错", () => {
      expect(() => repo.incrementRetrievalCounts([])).not.toThrow();
    });

    it("flagMemory 标记和取消标记", () => {
      repo.storeEntry("mem-1", makeEntry());

      repo.flagMemory("mem-1", true);
      expect(repo.getWeight("mem-1").userFlagged).toBe(true);

      repo.flagMemory("mem-1", false);
      expect(repo.getWeight("mem-1").userFlagged).toBe(false);
    });
  });

  describe("updateLayerByConversation", () => {
    it("批量更新 layer", () => {
      insertConversation(db, "conv-1");

      repo.storeEntry("mem-1", makeEntry({ conversationId: "conv-1", layer: "working" }));
      repo.storeEntry("mem-2", makeEntry({ conversationId: "conv-1", layer: "working", sourceId: "msg-2" }));
      repo.storeEntry("mem-3", makeEntry({ conversationId: "conv-1", layer: "historical", sourceId: "msg-3" }));

      repo.updateLayerByConversation("conv-1", "working", "historical");

      expect(repo.getById("mem-1")!.layer).toBe("historical");
      expect(repo.getById("mem-2")!.layer).toBe("historical");
      expect(repo.getById("mem-3")!.layer).toBe("historical");
    });

    it("不匹配的 conversationId 不影响其他条目", () => {
      insertConversation(db, "conv-1");
      insertConversation(db, "conv-2", "/conv/2");

      repo.storeEntry("mem-1", makeEntry({ conversationId: "conv-1", layer: "working" }));
      repo.storeEntry("mem-2", makeEntry({ conversationId: "conv-2", layer: "working", sourceId: "msg-2" }));

      repo.updateLayerByConversation("conv-1", "working", "historical");

      expect(repo.getById("mem-1")!.layer).toBe("historical");
      expect(repo.getById("mem-2")!.layer).toBe("working");
    });
  });
});
