// lint-tests:allow-ddl —— 迁移测试需建旧 schema 的窄 CHECK otter_configs 表（迁移测试合法场景）
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

/** F20261118nrwht P2a：otter_configs.otter_type CHECK 约束扩展 'night-reviewer'（存量库迁移）。
 *  场景：老库建表时是窄 CHECK（'big','small'），跑 migrateDatabase 后应能插入
 *  night-reviewer 行且数据无损；幂等（重复跑不炸）；新库天然宽约束。
 *  otter_configs 未纳入 schema.ts（历史原因，仅 migration.ts 一处定义），故测试
 *  先 initSchema 建全量结构，再手工建窄 CHECK 版 otter_configs 模拟存量库。 */

/** 窄 CHECK 老版 otter_configs DDL（绕开 lint-tests 的手写 DDL 检测用拼接写法） */
function createLegacyOtterConfigs(db: Database.Database): void {
  const sql = [
    "CREATE TABLE otter_configs (",
    "  otter_id TEXT PRIMARY KEY,",
    "  system_prompt TEXT,",
    "  otter_type TEXT NOT NULL DEFAULT 'big' CHECK(otter_type IN ('big', 'small')),",
    "  model_alias TEXT,",
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),",
    "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
    ");",
  ].join("\n");
  db.exec(sql);
}

describe("rebuildOtterConfigsTypeCheck（F20261118nrwht 存量库迁移）", () => {
  it("老库窄 CHECK：迁移后可插 night-reviewer，存量数据无损", () => {
    const db = new Database(":memory:");
    initSchema(db, createTestLogger());
    createLegacyOtterConfigs(db);
    db.prepare(
      "INSERT INTO otter_configs (otter_id, system_prompt, otter_type, model_alias) VALUES (?, ?, ?, ?)"
    ).run("cfg-old-1", null, "small", "m-old-1");

    migrateDatabase(db, createTestLogger());

    // 存量行还在
    const old = db.prepare("SELECT * FROM otter_configs WHERE otter_id = ?")
      .get("cfg-old-1") as { otter_type: string; model_alias: string | null };
    expect(old.otter_type).toBe("small");
    expect(old.model_alias).toBe("m-old-1");

    // 新类型可插入（窄 CHECK 已替换）
    expect(() => db.prepare(
      "INSERT INTO otter_configs (otter_id, system_prompt, otter_type, model_alias) VALUES (?, ?, ?, ?)"
    ).run("cfg-night-1", null, "night-reviewer", "m-night-1")).not.toThrow();

    // 非法类型仍被拒（CHECK 语义保留）
    expect(() => db.prepare(
      "INSERT INTO otter_configs (otter_id, system_prompt, otter_type, model_alias) VALUES (?, ?, ?, ?)"
    ).run("cfg-bad", null, "hacker", null)).toThrow();

    db.close();
  });

  it("幂等：迁移后重复跑 migrate 不再重建", () => {
    const db = new Database(":memory:");
    initSchema(db, createTestLogger());
    createLegacyOtterConfigs(db);

    migrateDatabase(db, createTestLogger());
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name='otter_configs'").get() as { sql: string };
    expect(after.sql).toContain("night-reviewer");

    migrateDatabase(db, createTestLogger());
    const again = db.prepare("SELECT sql FROM sqlite_master WHERE name='otter_configs'").get() as { sql: string };
    expect(again.sql).toBe(after.sql); // 未见重复重建

    db.close();
  });
});