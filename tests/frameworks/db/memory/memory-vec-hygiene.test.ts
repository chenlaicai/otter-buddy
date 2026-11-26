import { describe, expect, it } from "vitest";
import { createTestDb } from "../../../helpers/db";
import { auditMemoryVec, cleanupMemoryVec } from "@frameworks/db/memory/memory-vec-hygiene";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

const NOW = "2026-11-26T00:00:00.000Z";
const SECRET = "memory-content-must-not-leak";

function memoryEntry(id: string): MemoryEntry {
  return {
    id, layer: "working", contentType: "message", sourceId: id, sourceTable: "entries",
    conversationId: null, granularity: "fine", content: SECRET, metadata: null, createdAt: NOW,
  };
}

describe("memory_vec 孤儿索引审计与清理", () => {
  it("只读审计返回 total/live/orphan/orphanRatio，且不泄露正文", async () => {
    const db = createTestDb();
    try {
      const repo = new SqliteMemoryRepository(db);
      const version = await repo.storeEntry(memoryEntry("live-1"));
      await repo.storeEmbedding("live-1", version.generation, version.contentHash, new Float32Array(1024).fill(0.25));
      db.prepare("INSERT INTO memory_vec (memory_entry_id, embedding) VALUES ('orphan-1', ?)")
        .run(new Float32Array(1024).fill(0.5));

      const audit = auditMemoryVec(db);
      expect(audit).toEqual({ total: 2, live: 1, orphan: 1, orphanRatio: 0.5 });
      expect(JSON.stringify(audit)).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });

  it("清理只删孤儿并保留 live entry/vec，二次执行幂等", async () => {
    const db = createTestDb();
    try {
      const repo = new SqliteMemoryRepository(db);
      const version = await repo.storeEntry(memoryEntry("live-1"));
      await repo.storeEmbedding("live-1", version.generation, version.contentHash, new Float32Array(1024).fill(0.25));
      db.prepare("INSERT INTO memory_vec (memory_entry_id, embedding) VALUES ('orphan-1', ?)")
        .run(new Float32Array(1024).fill(0.5));

      const result = cleanupMemoryVec(db);
      expect(result.deleted).toBe(1);
      expect(result.before).toMatchObject({ total: 2, live: 1, orphan: 1 });
      expect(result.after).toEqual({ total: 1, live: 1, orphan: 0, orphanRatio: 0 });
      expect(db.prepare("SELECT 1 FROM memory_entries WHERE id = 'live-1'").get()).toBeDefined();
      expect(db.prepare("SELECT memory_entry_id FROM memory_vec").all()).toEqual([{ memory_entry_id: "live-1" }]);

      expect(cleanupMemoryVec(db)).toMatchObject({ deleted: 0, after: result.after });
    } finally {
      db.close();
    }
  });
});
