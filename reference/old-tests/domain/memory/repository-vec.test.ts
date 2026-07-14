import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import DatabaseConstructor from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { MemoryRepository } from "@domain/memory/_internal/repository";
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

function makeEmbedding(values: number[]): Float32Array {
  const arr = new Float32Array(1024);
  for (let i = 0; i < Math.min(values.length, 1024); i++) {
    arr[i] = values[i];
  }
  return arr;
}

describe.skipIf(!sqliteVecAvailable)("MemoryRepository vec0 操作", () => {
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

  it("hasVecTable 返回 true", () => {
    expect(repo.hasVecTable()).toBe(true);
  });

  it("storeEmbedding + getEmbedding 向量存储和读取", () => {
    repo.storeEntry("mem-1", makeEntry());

    const embedding = makeEmbedding([0.1, 0.2, 0.3]);
    repo.storeEmbedding("mem-1", embedding);

    const retrieved = repo.getEmbedding("mem-1")!;
    expect(retrieved).not.toBeNull();
    expect(retrieved.length).toBe(1024);
    expect(retrieved[0]).toBeCloseTo(0.1, 5);
    expect(retrieved[1]).toBeCloseTo(0.2, 5);
    expect(retrieved[2]).toBeCloseTo(0.3, 5);
  });

  it("getEmbedding 未找到返回 null", () => {
    expect(repo.getEmbedding("nonexistent")).toBeNull();
  });

  it("searchVec KNN 返回最近邻结果", () => {
    repo.storeEntry("mem-1", makeEntry({ content: "cat" }));
    repo.storeEntry("mem-2", makeEntry({ content: "dog", sourceId: "msg-2" }));
    repo.storeEntry("mem-3", makeEntry({ content: "fish", sourceId: "msg-3" }));

    repo.storeEmbedding("mem-1", makeEmbedding([1, 0, 0]));
    repo.storeEmbedding("mem-2", makeEmbedding([0, 1, 0]));
    repo.storeEmbedding("mem-3", makeEmbedding([0, 0, 1]));

    const queryVec = makeEmbedding([0.9, 0.1, 0]);
    const hits = repo.searchVec(queryVec, { limit: 3 });

    expect(hits.length).toBe(3);
    expect(hits[0].memoryEntryId).toBe("mem-1");
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it("searchVec granularity 过滤", () => {
    repo.storeEntry("mem-1", makeEntry({ content: "cat", granularity: "fine" }));
    repo.storeEntry("mem-2", makeEntry({ content: "dog", granularity: "coarse", sourceId: "msg-2" }));

    repo.storeEmbedding("mem-1", makeEmbedding([1, 0]));
    repo.storeEmbedding("mem-2", makeEmbedding([0.9, 0.1]));

    const hits = repo.searchVec(makeEmbedding([1, 0]), { granularity: "fine", limit: 10 });
    expect(hits.length).toBe(1);
    expect(hits[0].entry.granularity).toBe("fine");
  });

  it("searchVec conversationId 过滤", () => {
    insertConversation(db, "conv-1");
    insertConversation(db, "conv-2", "/conv/2");

    repo.storeEntry("mem-1", makeEntry({ content: "cat", conversationId: "conv-1" }));
    repo.storeEntry("mem-2", makeEntry({ content: "dog", conversationId: "conv-2", sourceId: "msg-2" }));

    repo.storeEmbedding("mem-1", makeEmbedding([1, 0]));
    repo.storeEmbedding("mem-2", makeEmbedding([0.9, 0.1]));

    const hits = repo.searchVec(makeEmbedding([1, 0]), { conversationId: "conv-1", limit: 10 });
    expect(hits.length).toBe(1);
    expect(hits[0].entry.conversationId).toBe("conv-1");
  });
});

describe.skipIf(sqliteVecAvailable)("MemoryRepository vec0 降级", () => {
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

  it("hasVecTable 返回 false", () => {
    expect(repo.hasVecTable()).toBe(false);
  });

  it("searchVec 返回空数组", () => {
    const hits = repo.searchVec(makeEmbedding([1]), { limit: 10 });
    expect(hits).toEqual([]);
  });
});
