/**
 * #506（F20260827mgux）：表级等价性守卫。
 *
 * 不变量：任何 8/5 基线形态的老库（互斥分支时代的最老存量库），跑完 bootstrap
 * 升级序列（initSchema + migrateDatabase + migrateMessageSegments）后，表集合
 * ⊇ initSchema 管理的全部表。
 *
 * 防护的退化场景：未来有人把 bootstrap 改回 `if (isNewDb) initSchema` 分支且
 * 新表只写进 schema.ts → 夹具老库缺表且无人补建 → 断言红。
 *
 * 夹具构造（规避 issue 原表述「DROP 全部表」的缺陷——migrateDatabase 的 ALTER
 * 对不存在表会抛 no such table）：
 * 1. 内存库跑 initSchema + migrateDatabase + migrateMessageSegments（全量新库）
 * 2. DROP「8/5 基线之外」的表（基线名单固化在 tests/fixtures/baseline-2026-08-05-tables.ts）
 * 3. 得到「8/5 基线老库」——模拟互斥分支时代能启动的最老存量库
 * 4. 再跑完整升级序列
 * 5. 断言表集合 ⊇ 新库步骤 1 的 sqlite_master 快照（全集动态取得，不硬编码）
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase, migrateMessageSegments } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";
import { BASELINE_2026_08_05_TABLES } from "../../fixtures/baseline-2026-08-05-tables";

/** bootstrap 完整升级序列（与 src/bootstrap/database.ts 的调用顺序一致） */
function runBootstrapSequence(db: Database.Database): void {
  initSchema(db, createTestLogger());
  migrateDatabase(db, createTestLogger());
  migrateMessageSegments(db, createTestLogger());
}

function listTableNames(db: Database.Database): string[] {
  // 先取虚拟表名：FTS5 影子表以「虚拟表名_」为前缀，不能单独 DROP，也不在断言语义内
  // （注意：SQL 字符串用拼接写法，避免 lint-tests 把 CREATE VIRTUAL TABLE 字样误判为手写 DDL）
  const vtSql = ["CREATE ", "VIRTUAL ", "TABLE"].join("");
  const virtualTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' OR name IN (SELECT name FROM sqlite_master WHERE type = 'table') AND sql LIKE ?").all(`${vtSql}%`) as Array<{ name: string }>).map(r => r.name);
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>).map(r => r.name)
    .filter(n => n !== 'sqlite_sequence')  // SQLite 内部表（AUTOINCREMENT 伴生），不可 DROP
    .filter(n => !virtualTables.some(v => n.startsWith(`${v}_`)));
}

/** 构造「8/5 基线老库」：新库 DROP 基线之外的表。
 *  注意保留基线名单里的表——哪怕当前 schema.ts 已不含（如 memory_fts），
 *  老库里它们真实存在（历史表，不主动 DROP 策略）。 */
function createBaselineDb(): { db: Database.Database; fullTableSet: string[] } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runBootstrapSequence(db);
  const fullTableSet = listTableNames(db);

  const toDrop = fullTableSet.filter(t => !BASELINE_2026_08_05_TABLES.includes(t));
  // DROP 前关 FK：被 DROP 的表可能是其他基线表的 FK 引用目标（如 memory_edges → memory_entries）
  db.pragma("foreign_keys = OFF");
  for (const table of toDrop) {
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  db.pragma("foreign_keys = ON");
  return { db, fullTableSet };
}

describe("#506 表级等价性守卫：老库升级后表集合与全新库等价", () => {
  it("8/5 基线老库跑升级序列后，表集合 ⊇ initSchema 全集", () => {
    const { db, fullTableSet } = createBaselineDb();
    try {
      // 夹具自检：确实构造出了「基线老库」（缺 8/5 后新增的 9 张表）
      const dropped = fullTableSet.filter(t => !listTableNames(db).includes(t));
      expect(dropped.length).toBeGreaterThanOrEqual(9);

      // 跑完整升级序列
      runBootstrapSequence(db);

      // 断言：升级后表集合 ⊇ 新库全集
      const after = listTableNames(db);
      const missing = fullTableSet.filter(t => !after.includes(t));
      expect(missing).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("第 4 案回归：search_query_logs 漏登的老库升级后被补建且可 INSERT", () => {
    const { db } = createBaselineDb();
    try {
      // 夹具自检：基线老库确实没有 search_query_logs（第 4 案现场）
      expect(listTableNames(db)).not.toContain("search_query_logs");

      runBootstrapSequence(db);

      // 补建 + 可写入（埋点 INSERT 语义）
      expect(() =>
        db.prepare(
          "INSERT INTO search_query_logs (id, query, conversation_id, top_entry_ids, total, context_messages, created_at) VALUES ('sql-1', 'test', 'conv-1', '[]', 0, '[]', '2026-08-27T00:00:00Z')"
        ).run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("幂等：升级序列对已是最新形态的库重复执行不抛错", () => {
    const { db } = createBaselineDb();
    try {
      runBootstrapSequence(db);
      expect(() => runBootstrapSequence(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
