import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SearchMemory } from "@usecases/memory/search-memory";
import { SearchEngine } from "@usecases/memory/search-engine";
import { buildMemoryClient } from "../../src/bootstrap/clients";
import type { UseCases } from "../../src/bootstrap/types";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";

const NOW = new Date().toISOString();

function engine(): SearchEngine {
  return new SearchEngine({
    rrfK: 60, alpha: 0.4, vecSimilarityThreshold: 0.3, bothBoost: 1.2,
    currentConversationBoost: 1.5, weightHalfLifeDays: 7,
    weightHalfLifeDaysDocument: 90, userFlagMultiplier: 2, frequencyBoostFactor: 0.1,
  });
}

function memoryEntry(id: string, content: string): MemoryEntry {
  return {
    id, layer: "working", contentType: "belief", sourceId: id, sourceTable: "facts",
    conversationId: "conv-1", granularity: "coarse", content,
    metadata: { kind: "preference", status: "verified", anchors: ["source-entry"], custom: "preserved" },
    createdAt: NOW,
  };
}

function failingEmbedding(): EmbeddingGateway {
  return { available: false, embed: async () => { throw new Error("embedding unavailable"); } };
}

describe("search_memory 完整结果出口（真实 SQLite + 真实 client/tool 链）", () => {
  it("六属性、debug、total、coverage、vecState 与独立 queueHealth 全透传", async () => {
    const db = createTestDb();
    try {
      const repo = new SqliteMemoryRepository(db);
      db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'test', 'active', ?, ?)").run(NOW, NOW);
      const original = memoryEntry("belief-old", "retrievalcontractmarker 搭档偏好可验证输出");
      const replacement = memoryEntry("belief-new", "replacement entry");
      await repo.storeEntry(original);
      await repo.storeEntry(replacement);
      await repo.createEdge({ fromEntryId: replacement.id, toEntryId: original.id, edgeType: "supersedes" });
      db.prepare("INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at) VALUES (?, datetime('now'), 'pending', datetime('now', '-120 seconds'))").run(original.id);
      db.prepare("INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at) VALUES (?, datetime('now'), 'dead', datetime('now', '-240 seconds'))").run(replacement.id);

      const searchMemory = new SearchMemory(repo, repo, failingEmbedding(), engine(), createTestLogger());
      const record = vi.fn(async () => undefined);
      const client = buildMemoryClient({ searchMemory, recordSearchQuery: { record } } as unknown as UseCases);
      const ctx = { client: { memory: client }, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "message-1" } as unknown as ToolContext;
      const tool = createTools(ctx).find((candidate) => candidate.name === "search_memory");
      if (!tool) throw new Error("search_memory missing");

      const response = await tool.execute("call-1", { query: "retrievalcontractmarker", detail_level: "summary", debug: true });
      const output = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
      const entry = output.entries[0];

      expect(entry.id).toBe(original.id);
      expect(entry.source).toBe("fts");
      expect(entry.beliefStatus).toBe("verified");
      expect(entry.supersededBy).toBe(replacement.id);
      expect(entry.drillDown).toEqual({ tool: "get_memory_detail", params: { ids: [original.id] } });
      expect(entry.debug).toMatchObject({ rrfScore: expect.any(Number), finalScore: expect.any(Number) });
      expect(entry.belief).toEqual({ kind: "preference", status: "verified", anchors: ["source-entry"] });
      expect(entry.metadata).toMatchObject({ custom: "preserved" });
      expect(output.total).toBe(1);
      expect(output.vecCoverage).toMatchObject({ total: 1, withVec: 0, ratio: 0 });
      expect(output.vecState).toBe("embed_failed");
      expect(output.queueHealth).toMatchObject({ pending: 1, dead: 1, oldestAgeSeconds: expect.any(Number) });
    } finally {
      db.close();
    }
  });
});
