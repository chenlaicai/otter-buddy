import { describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/db";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

const NOW = "2026-11-24T00:00:00.000Z";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";

function simulatePreC2(db: ReturnType<typeof createTestDb>): void {
  db.prepare("DELETE FROM settings WHERE key = 'entry_memory_projection_policy_version'").run();
}

function seedConversation(db: ReturnType<typeof createTestDb>, id: string, kind: "normal" | "external" = "normal"): void {
  db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'big', 'active', ?)")
    .run(`otter-${id}`, `Otter ${id}`, NOW);
  db.prepare("INSERT INTO conversations (id, title, status, kind, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
    .run(id, id, kind, NOW, NOW);
}

function seedEntry(
  db: ReturnType<typeof createTestDb>,
  input: { id: string; conversationId: string; body: string; type?: "user" | "speak"; source?: "external"; invokeId?: string },
): void {
  db.prepare(`
    INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
      body, invoke_id, status, source, sender_name, created_at, completed_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM entries WHERE conversation_id = ?), ?, ?, ?, ?, ?, 'completed', ?, '', ?, ?)
  `).run(
    input.id,
    input.conversationId,
    input.conversationId,
    input.type ?? "user",
    input.type === "speak" ? "otter" : "user",
    `otter-${input.conversationId}`,
    input.body,
    input.invokeId ?? null,
    input.source ?? null,
    NOW,
    NOW,
  );
}

describe("C2 entries → memory 老库政策回填（真实 SQLite）", () => {
  it("旧 backfilled=done 不豁免：external conversation/source 均不入 memory/FTS/tasks", () => {
    const db = createTestDb();
    try {
      seedConversation(db, "conv-external", "external");
      seedConversation(db, "conv-normal");
      seedEntry(db, { id: "external-kind", conversationId: "conv-external", body: "external kind secret" });
      seedEntry(db, { id: "external-source", conversationId: "conv-normal", body: "external source secret", source: "external" });
      seedEntry(db, { id: "normal-canary", conversationId: "conv-normal", body: "normal content must still project" });

      simulatePreC2(db);
      migrateDatabase(db, createTestLogger());

      const rows = db.prepare("SELECT id FROM memory_entries WHERE id IN ('external-kind', 'external-source')").all();
      const fts = db.prepare("SELECT memory_entry_id FROM memory_fts_jieba WHERE memory_entry_id IN ('external-kind', 'external-source')").all();
      const tasks = db.prepare("SELECT entry_id FROM embedding_tasks WHERE entry_id IN ('external-kind', 'external-source')").all();
      expect(rows).toEqual([]);
      expect(fts).toEqual([]);
      expect(tasks).toEqual([]);
      expect(db.prepare("SELECT id FROM memory_entries WHERE id = 'normal-canary'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("restricted invoke 的 external speak 即使历史 source 未标记也不投影", () => {
    const db = createTestDb();
    try {
      seedConversation(db, "conv-restricted");
      db.prepare("INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, metadata) VALUES ('invoke-restricted', 'conv-restricted', 'otter-conv-restricted', 'completed', ?, ?)")
        .run(NOW, JSON.stringify({ externalProfile: "restricted" }));
      seedEntry(db, { id: "external-speak", conversationId: "conv-restricted", body: "restricted answer", type: "speak", invokeId: "invoke-restricted" });
      seedEntry(db, { id: "normal-canary", conversationId: "conv-restricted", body: "normal content must still project" });

      simulatePreC2(db);
      migrateDatabase(db, createTestLogger());

      expect(db.prepare("SELECT id FROM memory_entries WHERE id = 'external-speak'").all()).toEqual([]);
      expect(db.prepare("SELECT id FROM memory_entries WHERE id = 'normal-canary'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("启动迁移不静默删除 external 历史污染，留给显式 audit/cleanup", () => {
    const db = createTestDb();
    try {
      seedConversation(db, "conv-legacy-external");
      seedEntry(db, { id: "legacy-external", conversationId: "conv-legacy-external", body: "legacy external", source: "external" });
      db.prepare("INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, granularity, content, created_at) VALUES ('legacy-external', 'working', 'message', 'legacy-external', 'entries', 'conv-legacy-external', 'fine', 'legacy external', ?)")
        .run(NOW);
      db.prepare("INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at) VALUES ('legacy-external', datetime('now'), 'pending', datetime('now'))").run();

      simulatePreC2(db);
      migrateDatabase(db, createTestLogger());

      expect(db.prepare("SELECT id FROM memory_entries WHERE id = 'legacy-external'").all()).toHaveLength(1);
      expect(db.prepare("SELECT entry_id FROM embedding_tasks WHERE entry_id = 'legacy-external'").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("旧 done 标记下仍补齐缺失普通投影并脱敏 memory 与 FTS", () => {
    const db = createTestDb();
    try {
      seedConversation(db, "conv-secret");
      seedEntry(db, { id: "normal-secret", conversationId: "conv-secret", body: `token=${SECRET}` });

      simulatePreC2(db);
      migrateDatabase(db, createTestLogger());

      const memory = db.prepare("SELECT content FROM memory_entries WHERE id = 'normal-secret'").get() as { content: string } | undefined;
      const fts = db.prepare("SELECT content FROM memory_fts_jieba WHERE memory_entry_id = 'normal-secret'").get() as { content: string } | undefined;
      expect(memory?.content).toBe("token=[REDACTED]");
      expect(memory?.content).not.toContain(SECRET);
      expect(fts?.content).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });

  it("已存在的未脱敏普通投影会被同一政策纠偏，而不是被主键存在判断跳过", () => {
    const db = createTestDb();
    try {
      seedConversation(db, "conv-existing");
      seedEntry(db, { id: "existing-secret", conversationId: "conv-existing", body: `password=${SECRET}` });
      db.prepare("INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, granularity, content, created_at) VALUES ('existing-secret', 'working', 'message', 'existing-secret', 'entries', 'conv-existing', 'fine', ?, ?)")
        .run(`password=${SECRET}`, NOW);

      simulatePreC2(db);
      migrateDatabase(db, createTestLogger());

      const memory = db.prepare("SELECT content FROM memory_entries WHERE id = 'existing-secret'").get() as { content: string };
      expect(memory.content).toBe("password=[REDACTED]");
      expect(memory.content).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });
});
