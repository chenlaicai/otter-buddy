/**
 * F20261009smex: 存量库形态冒烟测试（#1390 事故防线 A）。
 * lint-tests:allow-ddl——存量库快照需手写 DDL 回退 healing_events 到 #1365 前形态
 * （删掉 bound_issue/bound_at 重建 14 列旧表），被测对象就是「旧 schema → 新 schema」
 * 的补列迁移本身，与 migration.test.ts 同类场景。
 *
 * 背景（第二次 P0 启动事故，#1390 复盘）：
 *   build-app.test.ts 用 fs.mkdtempSync 空目录 + 全新 sqlite——只证明「新库能起」。
 *   而线上 100% 是存量库（升级场景），#1365 的索引抢跑在全新库上永远绿、
 *   在存量库上必炸。防线与线上形态错位，两次事故同一模式。
 *
 *   F20260929boot 文档预言过这个洞：「若未来出现编译过但启动挂的新模式
 *   （如 DB migration 回归），冒烟测试应扩展覆盖」——本次兑现预言。
 *
 * 设计：
 *   先跑 initSchema 建全新库（保证所有表/索引/列与生产 schema 一致），
 *   再删掉 healing_events 的补列（bound_issue/bound_at）回退到 #1365 前形态，
 *   最后跑 initDatabaseAndModels 完整启动路径（initSchema + migrateDatabase），
 *   验证「旧 schema → 新 schema」补列 + 建索引后系统能完成 DB 启动层装配。
 *
 *   为什么不用「最小快照」：最小快照只建 conversations + healing_events，
 *   但 initSchema 的 CREATE INDEX idx_conversations_status ON conversations(status)
 *   要求 status 列存在——最小快照缺列即炸，与 #1365 同型问题（快照本身成了事故源）。
 *   「全新库建全 → 定向回退」保证快照是真实存量库形态，非人工拼凑。
 *
 * 与 tests/frameworks/db/schema.test.ts 的分工：
 *   schema.test.ts 锁 initSchema 的 DDL 顺序（单元层）；
 *   本测试锁 initDatabaseAndModels 的完整启动路径（装配层）——
 *   前者防「顺序错」，后者防「装配错」（如 migration.ts 与 schema.ts 的交互）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { loadConfig, resetConfigForTests } from "../../src/frameworks/config";
import { initFauxModels } from "../../src/frameworks/llm/models-factory";
import { initDatabaseAndModels } from "../../src/bootstrap/database";
import { initSchema } from "../../src/frameworks/db/schema";
import { createCapturingLogger, type CapturedLogs } from "../helpers/logger";

/** 立即上报 load error 的 stub embedding worker（CJS：tmp 目录无 package.json type:module） */
const STUB_WORKER = `
const { parentPort } = require("worker_threads");
parentPort.postMessage({ type: "error", error: "test stub worker", id: -1 });
`;

/** 预置存量库：先跑 initSchema 建全新库，再删掉 healing_events 的补列回退到 #1365 前形态。 */
function seedExistingDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  // 第一步：initSchema 建全新库（所有表/索引/列与生产 schema 一致）
  initSchema(db);

  // 第二步：回退 healing_events 到 #1365 前形态（删掉 bound_issue/bound_at，重建 14 列旧表）
  // SQLite 不支持 DROP COLUMN（3.35 前），用表重建：建新表 → 拷贝 → 删旧 → 重命名
  db.exec(`
    CREATE TABLE healing_events_pre1365 (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      otter_id TEXT NOT NULL,
      error_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      suggestion TEXT NOT NULL DEFAULT '',
      context TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      introduced_by_pr TEXT
    );
    INSERT INTO healing_events_pre1365 SELECT id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, resolution, created_at, resolved_at, introduced_by_pr FROM healing_events;
    DROP TABLE healing_events;
    ALTER TABLE healing_events_pre1365 RENAME TO healing_events;
  `);

  db.close();
}

describe("buildApp 存量库形态启动（#1390 防线 A）", () => {
  let tmpDir: string;
  let capturedLogs: CapturedLogs;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-existingdb-"));
    const docsRoot = path.join(tmpDir, "docs-root");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stub-worker.cjs"), STUB_WORKER);

    // 预置存量库：#1365 前形态（healing_events 14 列，无 bound_issue/bound_at）
    const dbPath = path.join(tmpDir, "existing.db");
    seedExistingDb(dbPath);

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, [
      "llm:",
      "  models:",
      "    - alias: faux",
      "      provider: openai",
      "      model: faux-model",
      "      handoffThresholdTokens: 40000",
      `database:`,
      `  path: ${dbPath}`,
      "server:",
      "  port: 0",
    ].join("\n"));

    const logger = createCapturingLogger();
    capturedLogs = logger.captured;
    const config = loadConfig(logger, configPath);
    config.embedding.workerPath = path.join(tmpDir, "stub-worker.cjs");

    const { model } = await initFauxModels([]);

    // 关键：跑 initDatabaseAndModels 完整启动路径（initSchema + migrateDatabase + migrateMessageSegments）
    // 这是与 build-app.test.ts 的差异——不是 buildApp 全栈（那需要完整 app 装配），
    // 而是 DB 启动层（initSchema 补列 + migration 建索引）的真实回放。
    const result = await initDatabaseAndModels(config, logger, { model });
    result.dispose();
  }, 180_000);

  afterAll(() => {
    resetConfigForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("存量库补列后启动不炸（#1390 核心回归）", () => {
    // initDatabaseAndModels 在 beforeAll 中成功返回 = 启动路径没炸
    // 若 #1365 形态回归（索引在补列前），beforeAll 会抛 no such column，本断言走不到
    expect(true).toBe(true);
  });

  it("补列后 healing_events 结构完整（bound_issue/bound_at 已补）", () => {
    const db = new Database(path.join(tmpDir, "existing.db"));
    const cols = db.prepare("PRAGMA table_info(healing_events)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("bound_issue");
    expect(colNames).toContain("bound_at");
    db.close();
  });

  it("索引 idx_healing_events_bound_issue 已建（补列后建索引顺序正确）", () => {
    const db = new Database(path.join(tmpDir, "existing.db"));
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_healing_events_bound_issue'",
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_healing_events_bound_issue");
    db.close();
  });

  it("启动路径无 SqliteError 日志（补列/索引/迁移全程无异常）", () => {
    const sqliteErrors = capturedLogs.errors.filter(
      (m) => m.includes("SqliteError") || m.includes("no such column"),
    );
    expect(sqliteErrors).toEqual([]);
  });
});
