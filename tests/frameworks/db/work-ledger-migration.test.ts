/**
 * F20261027hwl1 迁移三不变量测试：DDL（老库补建）+ 数据（幂等不丢）+ 功能探针（迁移后可写读）。
 *
 * 老库形态：先建无 work ledger 表的库（模拟 10/27 之前的存量库），跑 initSchema
 * （#506 幂等补建路径）→ 三表存在 + 既有数据完好 + binder 全链路可写读。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { SqliteWorkLedgerRepository } from "@frameworks/db/health/sqlite-work-ledger-repository";
import { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { createTestLogger } from "../../helpers/logger";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => {
  db.close();
});

describe("存量库迁移：work ledger 三表补建", () => {
  it("DDL：老库跑 initSchema 后三表存在（#506 幂等补建）", () => {
    // 老库：initSchema 全量跑一遍后删掉三表（模拟 10/27 前形态）
    initSchema(db);
    db.exec("DROP TABLE IF EXISTS conversation_active_work; DROP TABLE IF EXISTS work_item_traces; DROP TABLE IF EXISTS work_items;");
    const before = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work%'").all() as Array<{ name: string }>).length;
    expect(before).toBe(0);

    // 迁移：bootstrap 无条件 initSchema → CREATE TABLE IF NOT EXISTS 补建
    initSchema(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('work_items','work_item_traces','conversation_active_work')").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name).sort()).toEqual(["conversation_active_work", "work_item_traces", "work_items"]);
    // migrateDatabase 不抛（幂等重入安全）
    expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
  });

  it("数据：补建不动既有行；重跑 initSchema 不丢已登记工作", async () => {
    initSchema(db);
    db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('o1', '獭', 'big', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c1', '对话', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    const repo = new SqliteWorkLedgerRepository(db);
    const binder = new WorkLedgerBinder(repo, createTestLogger(), () => "2026-10-27T10:00:00Z");
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-1", title: "迁移前工作" });

    // 重跑（幂等）
    initSchema(db);
    const back = await repo.getWorkById(w.id);
    expect(back?.title).toBe("迁移前工作");
    const traces = await repo.listTraces(w.id);
    expect(traces.length).toBe(1);
  });

  it("功能探针：老库迁移后 track_work 全链路（start→invoke 归属→报告）", async () => {
    initSchema(db);
    db.exec("DROP TABLE IF EXISTS conversation_active_work; DROP TABLE IF EXISTS work_item_traces; DROP TABLE IF EXISTS work_items;");
    initSchema(db); // 补建

    db.prepare(`INSERT INTO otters (id, name, type, created_at) VALUES ('o1', '獭', 'big', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('c1', '对话', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    const repo = new SqliteWorkLedgerRepository(db);
    const binder = new WorkLedgerBinder(repo, createTestLogger(), () => "2026-10-27T10:00:00Z");
    const w = await binder.start({ conversationId: "c1", otterId: "o1", traceId: "t-probe", title: "探针工作" });
    db.prepare(`INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, token_usage_input, token_usage_output, metadata) VALUES ('i1', 'c1', 'o1', 'completed', '2026-10-27T09:00:00Z', 10, 5, ?)`).run(JSON.stringify({ traceId: "t-probe" }));

    const attributions = await repo.listInvokeAttributions();
    expect(attributions.length).toBe(1);
    expect(attributions[0]!.workId).toBe(w.id);
    expect(attributions[0]!.traceId).toBe("t-probe");
  });
});
