// lint-tests:allow-ddl —— 迁移测试需建旧 schema 的窄 CHECK attachments 表（迁移测试合法场景）
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

/** Issue #608：attachments 表 kind CHECK 约束扩展 audio/video（存量库迁移）。
 *  场景：老库建表时是窄 CHECK（'image','document'），跑 migrateDatabase 后
 *  应能插入 audio/video 行且数据无损；幂等（重复跑不炸）；新库天然宽约束。 */

/** 把新库的 attachments 表替换为窄 CHECK 老版（模拟 F20260830wxmd 时代存量库）。
 *  先 initSchema 建全量结构，再 DROP 重建窄版——migrateDatabase 的其他迁移
 *  步骤依赖全量表结构（agent_sessions 等），纯手工建表跑不动完整迁移序列。 */
function downgradeToLegacyAttachments(db: Database.Database): void {
  db.exec("DROP TABLE message_attachments");
  db.exec("DROP TABLE attachments");
  createLegacyAttachments(db);
  db.exec([
    "CREATE TABLE message_attachments (",
    "  message_id TEXT NOT NULL,",
    "  attachment_id TEXT NOT NULL,",
    "  sequence_num INTEGER NOT NULL DEFAULT 0,",
    "  PRIMARY KEY (message_id, attachment_id),",
    "  FOREIGN KEY (attachment_id) REFERENCES attachments(id)",
    ");",
  ].join("\n"));
}

/** 窄 CHECK 老版 attachments DDL（绕开 lint-tests 的手写 DDL 检测用拼接写法） */
function createLegacyAttachments(db: Database.Database): void {
  const sql = [
    "CREATE TABLE attachments (",
    "  id TEXT PRIMARY KEY,",
    "  sha256 TEXT NOT NULL,",
    "  file_path TEXT NOT NULL,",
    "  original_name TEXT NOT NULL,",
    "  mime_type TEXT NOT NULL,",
    "  kind TEXT NOT NULL CHECK(kind IN ('image', 'document')),",
    "  size_bytes INTEGER NOT NULL,",
    "  width INTEGER,",
    "  height INTEGER,",
    "  caption TEXT,",
    "  uploader_id TEXT NOT NULL,",
    "  created_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ");",
  ].join("\n");
  db.exec(sql);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256, uploader_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id);");
}

describe("rebuildAttachmentsKindCheck（#608 存量库迁移）", () => {
  it("老库窄 CHECK：迁移后可插 audio/video，存量数据无损", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeToLegacyAttachments(db);
    db.prepare(
      "INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("att-old-1", "sha-old-1", "attachments/aa/bb/x.png", "old.png", "image/png", "image", 123, "user-1");

    migrateDatabase(db, createTestLogger());

    // 存量行还在
    const old = db.prepare("SELECT * FROM attachments WHERE id = ?").get("att-old-1") as { kind: string; size_bytes: number };
    expect(old.kind).toBe("image");
    expect(old.size_bytes).toBe(123);

    // 新 kind 可插入（窄 CHECK 已替换）
    expect(() => db.prepare(
      "INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("att-new-1", "sha-new-1", "attachments/cc/dd/v.wav", "v.wav", "audio/wav", "audio", 456, "user-1")).not.toThrow();
    expect(() => db.prepare(
      "INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("att-new-2", "sha-new-2", "attachments/cc/ee/m.mp4", "m.mp4", "video/mp4", "video", 789, "user-1")).not.toThrow();

    // 唯一索引随重建保留（撞 sha256+uploader 抛错）
    expect(() => db.prepare(
      "INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("att-dup", "sha-new-1", "x", "x", "audio/wav", "audio", 1, "user-1")).toThrow();

    // 非法 kind 仍被拒（CHECK 语义保留）
    expect(() => db.prepare(
      "INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("att-bad", "sha-bad", "x", "x", "text/html", "html", 1, "user-1")).toThrow();

    db.close();
  });

  it("message_attachments FK 在表重建后仍有效（级联删除不炸）", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeToLegacyAttachments(db);

    migrateDatabase(db, createTestLogger());

    db.prepare("INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES ('a1', 's1', 'p', 'n', 'audio/wav', 'audio', 1, 'u')")
      .run();
    // FK 引用经重建后仍有效（不抛 foreign key mismatch）
    expect(() => db.prepare("INSERT INTO message_attachments (message_id, attachment_id) VALUES ('m1', 'a1')").run()).not.toThrow();
    db.close();
  });

  it("幂等：新库（宽 CHECK）跑 migrate 不重建不炸", () => {
    const db = new Database(":memory:");
    initSchema(db, createTestLogger());
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='attachments'").get() as { sql: string };
    migrateDatabase(db, createTestLogger());
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name='attachments'").get() as { sql: string };
    expect(before.sql).toBe(after.sql); // 新库未触发重建
    expect(after.sql).toContain("audio"); // 新库天然宽约束
    db.close();
  });

  it("迁移后重复跑 migrate 幂等（老库迁完不再重建）", () => {
    const db = new Database(":memory:");
    initSchema(db, createTestLogger());
    downgradeToLegacyAttachments(db);
    migrateDatabase(db, createTestLogger());
    const first = db.prepare("SELECT sql FROM sqlite_master WHERE name='attachments'").get() as { sql: string };
    migrateDatabase(db, createTestLogger());
    const second = db.prepare("SELECT sql FROM sqlite_master WHERE name='attachments'").get() as { sql: string };
    expect(first.sql).toBe(second.sql);
    db.close();
  });
});
