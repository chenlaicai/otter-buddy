import { describe, expect, it } from "vitest";
import { createTestDb } from "../../../helpers/db";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

const NOW = "2026-11-26T00:00:00.000Z";

function memoryEntry(id: string, sourceId: string): MemoryEntry {
  return {
    id, layer: "document", contentType: "feature_chunk", sourceId, sourceTable: "features",
    conversationId: null, granularity: "fine", content: `${id} 删除一致性`, metadata: null, createdAt: NOW,
  };
}

describe("记忆正常删除路径的卫星一致性", () => {
  it("deleteBySource 清除目标 FTS/vec/weights/generation/task/edge，其他 entry 全量保留", async () => {
    const db = createTestDb();
    try {
      const repo = new SqliteMemoryRepository(db);
      const target = memoryEntry("delete-target", "F-delete");
      const survivor = memoryEntry("delete-survivor", "F-survivor");
      const targetVersion = await repo.storeEntry(target);
      const survivorVersion = await repo.storeEntry(survivor);
      await repo.storeEmbedding(target.id, targetVersion.generation, targetVersion.contentHash, new Float32Array(1024).fill(0.25));
      await repo.storeEmbedding(survivor.id, survivorVersion.generation, survivorVersion.contentHash, new Float32Array(1024).fill(0.5));
      await repo.enqueueRetry(target.id, new Error("pending"));
      await repo.createEdge({ fromEntryId: target.id, toEntryId: survivor.id, edgeType: "relates-to" });

      await repo.deleteBySource(target.sourceTable, target.sourceId);

      const targetRows = {
        entries: db.prepare("SELECT 1 FROM memory_entries WHERE id = ?").all(target.id),
        fts: db.prepare("SELECT 1 FROM memory_fts_jieba WHERE memory_entry_id = ?").all(target.id),
        vec: db.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = ?").all(target.id),
        weights: db.prepare("SELECT 1 FROM memory_weights WHERE memory_entry_id = ?").all(target.id),
        generations: db.prepare("SELECT 1 FROM memory_vec_generations WHERE entry_id = ?").all(target.id),
        tasks: db.prepare("SELECT 1 FROM embedding_tasks WHERE entry_id = ?").all(target.id),
        edges: db.prepare("SELECT 1 FROM memory_edges WHERE from_entry_id = ? OR to_entry_id = ?").all(target.id, target.id),
      };
      expect(Object.values(targetRows).every(rows => rows.length === 0)).toBe(true);

      expect(db.prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(survivor.id)).toBeDefined();
      expect(db.prepare("SELECT 1 FROM memory_fts_jieba WHERE memory_entry_id = ?").get(survivor.id)).toBeDefined();
      expect(db.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = ?").get(survivor.id)).toBeDefined();
      expect(db.prepare("SELECT 1 FROM memory_weights WHERE memory_entry_id = ?").get(survivor.id)).toBeDefined();
      expect(db.prepare("SELECT 1 FROM memory_vec_generations WHERE entry_id = ?").get(survivor.id)).toBeDefined();
    } finally {
      db.close();
    }
  });
});
