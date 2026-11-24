import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryEntry } from "@entities/memory/memory-entry";

const NOW = new Date().toISOString();

function engine(): SearchEngine {
  return new SearchEngine({
    rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2,
    currentConversationBoost: 1.5, weightHalfLifeDays: 7,
    weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1,
  });
}

function successfulEmbedding(): EmbeddingGateway {
  return { available: true, embed: async () => new Float32Array(1024).fill(0.25) };
}

function failingEmbedding(): EmbeddingGateway {
  return { available: false, embed: async () => { throw new Error("embedding failed"); } };
}

async function setup(embedding: EmbeddingGateway) {
  const db = createTestDb();
  const repo = new SqliteMemoryRepository(db);
  db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'test', 'active', ?, ?)").run(NOW, NOW);
  const entry: MemoryEntry = {
    id: "entry-1", layer: "working", contentType: "message", sourceId: "entry-1",
    sourceTable: "entries", conversationId: "conv-1", granularity: "fine",
    content: "vectorstatemarker remains searchable through FTS", metadata: null, createdAt: NOW,
  };
  await repo.storeEntry(entry);
  const search = new SearchMemory(repo, repo, embedding, engine(), createTestLogger());
  return { db, repo, search };
}

describe("vec 检索状态与降级", () => {
  it("文本嵌入异步拒绝时保留 FTS 命中并报告 embed_failed", async () => {
    const { db, search } = await setup(failingEmbedding());
    try {
      const result = await search.search({ query: "vectorstatemarker", limit: 5 });
      expect(result.entries.map((entry) => entry.id)).toContain("entry-1");
      expect(result.vecState).toBe("embed_failed");
    } finally {
      db.close();
    }
  });

  it("底层 vec 查询异步拒绝时保留 FTS 命中并报告 query_failed", async () => {
    const { db, repo, search } = await setup(successfulEmbedding());
    try {
      vi.spyOn(repo, "searchVec").mockRejectedValue(new Error("vec query failed"));
      const result = await search.search({ query: "vectorstatemarker", limit: 5 });
      expect(result.entries.map((entry) => entry.id)).toContain("entry-1");
      expect(result.vecState).toBe("query_failed");
    } finally {
      db.close();
    }
  });

  it("vec 路径可用且两阶段成功时报告 ok", async () => {
    const { db, search } = await setup(successfulEmbedding());
    try {
      const result = await search.search({ query: "vectorstatemarker", limit: 5 });
      expect(result.entries.map((entry) => entry.id)).toContain("entry-1");
      expect(result.vecState).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("vec 禁用时报告 disabled 且不调用文本嵌入", async () => {
    const { db, repo, search } = await setup(successfulEmbedding());
    try {
      repo.disableVec();
      const result = await search.search({ query: "vectorstatemarker", limit: 5 });
      expect(result.entries.map((entry) => entry.id)).toContain("entry-1");
      expect(result.vecState).toBe("disabled");
    } finally {
      db.close();
    }
  });

  it("searchSimilar 的 vec 查询异步拒绝时降级为空结果而不抛出", async () => {
    const { db, repo, search } = await setup(successfulEmbedding());
    try {
      await repo.storeEmbedding("entry-1", new Float32Array(1024).fill(0.25));
      vi.spyOn(repo, "searchVec").mockRejectedValue(new Error("similar query failed"));
      const result = await search.searchSimilar("entry-1", 5);
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.vecState).toBe("query_failed");
    } finally {
      db.close();
    }
  });
});
