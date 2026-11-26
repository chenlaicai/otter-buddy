import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";

/**
 * 对话绑定移除迁移（统一注册制）：
 * - 存量库带 current_machine_id 列 → 启动迁移 DROP（列消失、数据不残留）
 * - 新库 → 建表即无该列（幂等 DROP 静默）
 * - 迁移后对话正常读写（列移除不破坏既有 CRUD 面）
 *
 * lint-tests:allow-ddl——被测对象就是旧表形态到新表形态的 DROP 迁移，
 * 生产 schema 建不出含 current_machine_id 的前旧形态。
 */

describe("conversations.current_machine_id 移除迁移", () => {
  it("存量库：带列启动 → 列被 DROP，表其余结构完整", () => {
    const db = new Database(":memory:");
    // 手造旧库形态（PR-1 时代的建表语句含绑定列）
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'normal',
        workspace_dir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        archived_at TEXT,
        current_machine_id TEXT
      );
    `);
    db.prepare("INSERT INTO conversations (id, title, current_machine_id) VALUES ('c-1', '存量对话', 'connector-b')").run();

    initSchema(db);

    const cols = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain("current_machine_id");
    // 结构与新库逐字一致：PK/默认值/列顺序不被 DROP 迁移破坏（不只断言行数）
    const reference = new Database(":memory:");
    initSchema(reference);
    const migratedDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get() as { sql: string };
    const referenceDdl = reference.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get() as { sql: string };
    // SQLite DROP COLUMN 会保留旧建表语句的缩进/右括号位置；只归一化排版空白，语义仍逐字比对。
    const normalizeDdl = (sql: string) => sql.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
    expect(normalizeDdl(migratedDdl.sql)).toBe(normalizeDdl(referenceDdl.sql));
    reference.close();
    // 存量对话行保留（绑定值随列消失——语义由动作级 machine 显式参数取代）
    expect((db.prepare("SELECT id FROM conversations").all() as Array<{ id: string }>).map(r => r.id)).toEqual(["c-1"]);
    db.close();
  });

  it("新库：建表即无该列（幂等 DROP 静默不抛）", () => {
    const db = new Database(":memory:");
    expect(() => initSchema(db)).not.toThrow();
    const cols = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain("current_machine_id");
    db.close();
  });

  it("迁移后对话 CRUD 正常（列移除不破坏读写面）", () => {
    const db = new Database(":memory:");
    initSchema(db);
    db.prepare("INSERT INTO conversations (id, title) VALUES ('c-2', '新对话')").run();
    const row = db.prepare("SELECT id, title, status FROM conversations WHERE id = 'c-2'").get() as { id: string; title: string; status: string };
    expect(row).toMatchObject({ id: "c-2", title: "新对话", status: "active" });
    db.prepare("UPDATE conversations SET pinned = 1 WHERE id = 'c-2'").run();
    expect((db.prepare("SELECT pinned FROM conversations WHERE id = 'c-2'").get() as { pinned: number }).pinned).toBe(1);
    db.close();
  });

  it("重复 initSchema 幂等（二次启动列已不存在，DROP 静默）", () => {
    const db = new Database(":memory:");
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });
});
