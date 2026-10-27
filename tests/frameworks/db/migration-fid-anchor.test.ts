import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

describe("FID read 锚点的存量 FTS 重建（F20261027-fidr）", () => {
  it.each(["F20261027-59c4", "F202609048840"])("新旧 ID %s 均注入", (fid) => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('fts_jieba_double_write', 'v1')").run();
      db.prepare(`INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, granularity, content, created_at)
        VALUES (?, 'document', 'feature', ?, 'features', 'coarse', '正文不含编号', '2026-10-27T00:00:00Z')`).run(`entry-${fid}`, fid);
      migrateDatabase(db, createTestLogger());
      const hit = db.prepare("SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_fts_jieba MATCH ?")
        .get(`"${fid}"`) as { c: number };
      expect(hit.c).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
