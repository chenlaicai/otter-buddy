import { describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/db";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { auditMemoryProjection, cleanupMemoryProjection } from "@frameworks/db/memory/memory-projection-maintenance";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { hashEntryProjectionContent } from "@usecases/memory/entry-projection-policy";

const NOW = "2026-11-24T00:00:00.000Z";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";

function seedEntry(db: ReturnType<typeof createTestDb>, id: string, body: string, source: "external" | null): void {
  db.prepare("INSERT OR IGNORE INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'test', 'active', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('user-1', 'chen', 'big', 'active', ?)").run(NOW);
  db.prepare(`INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
    body, status, source, sender_name, created_at, completed_at)
    VALUES (?, 'conv-1', (SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM entries WHERE conversation_id = 'conv-1'),
      'user', 'user', 'user-1', ?, 'completed', ?, '', ?, ?)`).run(id, body, source, NOW, NOW);
}

function legacyMemory(id: string, content: string): MemoryEntry {
  return {
    id, layer: "working", contentType: "message", sourceId: id, sourceTable: "entries",
    conversationId: "conv-1", granularity: "fine", content, metadata: null, createdAt: NOW,
  };
}

describe("C2 memory projection audit/cleanup（真实 SQLite + vec0）", () => {
  it("audit 不泄露正文；cleanup 清 external 全卫星、纠偏 secret，且二次执行幂等", async () => {
    const db = createTestDb();
    try {
      seedEntry(db, "external-1", "external private body", "external");
      seedEntry(db, "normal-1", `token=${SECRET}`, null);
      const repo = new SqliteMemoryRepository(db);
      await repo.storeEntry(legacyMemory("external-1", "external private body"));
      await repo.storeEntry(legacyMemory("normal-1", `token=${SECRET}`));
      await repo.storeEntry(legacyMemory("edge-target", "relation target"));
      await repo.storeEmbedding("external-1", 1, hashEntryProjectionContent("external private body"), new Float32Array(1024).fill(0.5));
      await repo.storeEmbedding("normal-1", 1, hashEntryProjectionContent(`token=${SECRET}`), new Float32Array(1024).fill(0.25));
      await repo.enqueueRetry("external-1", new Error("pending"));
      await repo.enqueueRetry("normal-1", new Error("pending"));
      await repo.createEdge({ fromEntryId: "external-1", toEntryId: "edge-target", edgeType: "relates-to" });

      const audit = auditMemoryProjection(db);
      expect(audit.items.map((item) => [item.entryId, item.kind])).toEqual([
        ["external-1", "external"],
        ["normal-1", "different"],
      ]);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain("external private body");
      expect(serialized).not.toContain(SECRET);
      expect(serialized).toMatch(/[a-f0-9]{64}/);

      const result = cleanupMemoryProjection(db);
      expect(result.after.items).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_entries WHERE id = 'external-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_fts_jieba WHERE memory_entry_id = 'external-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = 'external-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_weights WHERE memory_entry_id = 'external-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM embedding_tasks WHERE entry_id = 'external-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_edges WHERE from_entry_id = 'external-1' OR to_entry_id = 'external-1'").all()).toEqual([]);

      const normal = db.prepare("SELECT content FROM memory_entries WHERE id = 'normal-1'").get() as { content: string };
      const normalFts = db.prepare("SELECT content FROM memory_fts_jieba WHERE memory_entry_id = 'normal-1'").get() as { content: string };
      expect(normal.content).toBe("token=[REDACTED]");
      expect(normalFts.content).not.toContain(SECRET);
      expect(db.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = 'normal-1'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM embedding_tasks WHERE entry_id = 'normal-1'").all()).toEqual([]);

      const second = cleanupMemoryProjection(db);
      expect(second.before.items).toEqual([]);
      expect(second.after.items).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("external 主表已缺但卫星残留时仍能审计并清理", () => {
    const db = createTestDb();
    try {
      seedEntry(db, "external-orphan", "external orphan", "external");
      db.prepare("INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at) VALUES ('external-orphan', datetime('now'), 'pending', datetime('now'))").run();
      db.prepare("INSERT INTO memory_vec (memory_entry_id, embedding) VALUES ('external-orphan', ?)").run(new Float32Array(1024).fill(0.5));
      const audit = auditMemoryProjection(db);
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]).toMatchObject({ entryId: "external-orphan", kind: "external" });
      cleanupMemoryProjection(db);
      expect(db.prepare("SELECT 1 FROM embedding_tasks WHERE entry_id = 'external-orphan'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = 'external-orphan'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
