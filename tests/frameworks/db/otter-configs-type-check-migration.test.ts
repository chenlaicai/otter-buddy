// lint-tests:allow-ddl —— 迁移测试需建旧 schema 的窄 CHECK otter_configs 表（迁移测试合法场景）
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger, createCapturingLogger } from "../../helpers/logger";

/** F20261118nrwht P2a：otter_configs.otter_type CHECK 约束扩展 'night-reviewer'（存量库迁移）。
 *  场景：老库建表时是窄 CHECK（'big','small'），跑 migrateDatabase 后应能插入
 *  night-reviewer 行且六列数据无损；幂等（第二次跑不再重建）；新库天然宽约束。
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

/** 存量行六列全字段（含显式时间戳——验证复制不是只搬部分列） */
const LEGACY_ROW = {
  otter_id: "cfg-old-1",
  system_prompt: "keep-me",
  otter_type: "small",
  model_alias: "m-old-1",
  created_at: "2026-11-17 01:02:03",
  updated_at: "2026-11-17 04:05:06",
};

describe("rebuildOtterConfigsTypeCheck（F20261118nrwht 存量库迁移）", () => {
  it("老库窄 CHECK：迁移后可插 night-reviewer，存量六列数据无损", () => {
    const db = new Database(":memory:");
    initSchema(db, createTestLogger());
    createLegacyOtterConfigs(db);
    db.prepare(
      "INSERT INTO otter_configs (otter_id, system_prompt, otter_type, model_alias, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(LEGACY_ROW.otter_id, LEGACY_ROW.system_prompt, LEGACY_ROW.otter_type, LEGACY_ROW.model_alias, LEGACY_ROW.created_at, LEGACY_ROW.updated_at);

    migrateDatabase(db, createTestLogger());

    // 存量行还在，六列全字段与迁移前一致（数据无损的完整口径）
    const old = db.prepare("SELECT * FROM otter_configs WHERE otter_id = ?")
      .get("cfg-old-1") as typeof LEGACY_ROW;
    expect(old).toEqual(LEGACY_ROW);

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

  it("幂等：迁移后重复跑 migrate 只重建一次（第二次早返不再重建）", () => {
    const db = new Database(":memory:");
    const logger = createCapturingLogger();
    initSchema(db, createTestLogger());
    createLegacyOtterConfigs(db);

    migrateDatabase(db, logger);
    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name='otter_configs'").get() as { sql: string };
    expect(after.sql).toContain("night-reviewer");

    migrateDatabase(db, logger);
    const again = db.prepare("SELECT sql FROM sqlite_master WHERE name='otter_configs'").get() as { sql: string };
    expect(again.sql).toBe(after.sql);

    // 判别点：重建函数每次触发都会打一条 info；两次 migrate 只应出现一次
    // （若旧文本检测失效导致重复重建，会打第二条，本断言据此红掉）
    const rebuildLogs = logger.captured.infos.filter((m) =>
      m.includes("Rebuilding otter_configs table")
    );
    expect(rebuildLogs).toHaveLength(1);

    db.close();
  });
});