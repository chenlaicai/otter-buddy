import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import { loadConfig } from "@frameworks/config-service";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import type { MemoryEntry } from "@entities/memory/memory-entry";

const NOW = new Date().toISOString();

function engine(vecCandidateLimit?: number): SearchEngine {
  return new SearchEngine({
    rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.1, bothBoost: 1.2,
    currentConversationBoost: 1.5, weightHalfLifeDays: 14,
    weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1,
    ...(vecCandidateLimit !== undefined ? { vecCandidateLimit } : {}),
  });
}

function successfulEmbedding(): EmbeddingGateway {
  return { available: true, embed: async () => new Float32Array(1024).fill(0.25) };
}

async function setup(eng: SearchEngine) {
  const db = createTestDb();
  const repo = new SqliteMemoryRepository(db);
  db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'test', 'active', ?, ?)").run(NOW, NOW);
  const entry: MemoryEntry = {
    id: "entry-1", layer: "working", contentType: "message", sourceId: "entry-1",
    sourceTable: "entries", conversationId: "conv-1", granularity: "fine",
    content: "candidatelimit marker content for vec knn depth", metadata: null, createdAt: NOW,
  };
  await repo.storeEntry(entry);
  const search = new SearchMemory(repo, repo, successfulEmbedding(), eng, createTestLogger());
  return { db, repo, search };
}

/**
 * vec 候选池深度从「跟随 query.limit」解耦为独立配置 vecCandidateLimit（默认 20）。
 * 断言口径说明：reader.searchVec 的 k 参数是 MemoryReader 边界契约的一部分（vec0 KNN 深度），
 * 本变更的行为本体就是「传给该边界的深度值」——spy 断言边界传参而非内部调用
 * （与 search-memory-vec-state.test.ts 对 searchVec 的 spy 同口径）。
 */
describe("vecCandidateLimit 池深接线", () => {
  it("SearchEngine 缺省回填 vecCandidateLimit=20", () => {
    const eng = new SearchEngine();
    expect(eng.configRef.vecCandidateLimit).toBe(20);
  });

  it("缺省池深 20：search(limit=5) 传给 vec KNN 的 k=20，不再跟随 limit", async () => {
    const { db, repo, search } = await setup(engine());
    try {
      const spy = vi.spyOn(repo, "searchVec");
      await search.search({ query: "candidatelimit", limit: 5 });
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.calls[0][1]).toBe(20);
    } finally {
      db.close();
    }
  });

  it("显式配置生效：vecCandidateLimit=15 时 KNN k=15", async () => {
    const { db, repo, search } = await setup(engine(15));
    try {
      const spy = vi.spyOn(repo, "searchVec");
      await search.search({ query: "candidatelimit", limit: 5 });
      expect(spy.mock.calls[0][1]).toBe(15);
    } finally {
      db.close();
    }
  });

  it("config 默认值（loadConfig 无 memory 段）：threshold=0.1 / halfLifeDays=14 / vecCandidateLimit=20", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "swtch-config-"));
    const configPath = path.join(tmpDir, "config.yaml");
    writeFileSync(configPath, [
      "llm:",
      "  default: faux",
      "  models:",
      "    - alias: faux",
      "      provider: openai",
      "      model: faux-model",
      "      handoffThresholdTokens: 40000",
      "database:",
      `  path: ${path.join(tmpDir, "test.db")}`,
      "server:",
      "  port: 0",
    ].join("\n"));
    const config = loadConfig(createTestLogger(), configPath);
    expect(config.memory.vecSimilarityThreshold).toBe(0.1);
    expect(config.memory.weightHalfLifeDays).toBe(14);
    expect(config.memory.vecCandidateLimit).toBe(20);
  });
});
