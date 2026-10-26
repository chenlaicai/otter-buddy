/**
 * F20261026emct：embedding 幽灵死信清理脚本集成测试（对齐
 * tests/scripts/cleanup-memory-pollution.test.ts 模式——execFile 真实执行）。
 *
 * 在真实临时 DB 上注入模拟数据，验证：
 * 1. dry-run（默认）只报告不删除
 * 2. --apply 删除幽灵死信（last_error LIKE '%entry deleted%' 的 pending/dead），
 *    非幽灵形态（timeout dead / 正常 pending）保留
 * 3. --apply 前自动备份
 *
 * lint-tests:allow-ddl——豁免理由：脚本测试对象是 embedding_tasks 表的
 * 清理 SQL 本身，必须建真实表（与 cleanup-memory-pollution.test.ts 同模式）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initSchema } from "@frameworks/db/schema";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../../scripts/cleanup-embedding-ghosts.mjs");

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-ghost-test-"));
  dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  await loadSqliteVec(db);
  initSchema(db);

  // 注入：3 条 entry-已删孤儿（ghost pending/dead + batch timeout 残骸）+ 1 条正常
  // pending（entry 存活）+ 2 条 entry（delta 口径：真定义 NOT EXISTS 全删，含 10-23 巨批残骸形态）
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, granularity, content, created_at)
    VALUES
      ('e1', 'raw', 'message', 's1', 'message', 'conversation', '内容1', datetime('now')),
      ('e2', 'raw', 'message', 's2', 'message', 'conversation', '内容2', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO embedding_tasks (entry_id, next_retry_at, status, attempts, created_at, last_error)
    VALUES
      ('ghost-1', datetime('now'), 'pending', 1, datetime('now'), 'entry deleted (content join failed)'),
      ('ghost-2', datetime('now'), 'dead', 3, datetime('now'), 'embed failed: entry deleted'),
      ('ghost-3', datetime('now'), 'pending', 2, datetime('now'), 'Embed batch timeout after 120000ms (49 texts)'),
      ('e1', datetime('now'), 'pending', 0, datetime('now'), NULL)
  `).run();
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function countTasks(): { orphan: number; total: number } {
  const orphan = (db.prepare(`
    SELECT COUNT(*) AS n FROM embedding_tasks et
    WHERE et.entry_id NOT IN (SELECT id FROM memory_entries)
  `).get() as { n: number }).n;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM embedding_tasks").get() as { n: number }).n;
  return { orphan, total };
}

describe("cleanup-embedding-ghosts.mjs", () => {
  it("dry-run（默认）：报告 3 条孤儿（含巨批残骸形态）且不删除", async () => {
    const { stdout } = await execFileAsync("node", [SCRIPT, `--db=${dbPath}`]);
    expect(stdout).toContain("[orphan]");
    expect(stdout).toContain("3 条");
    expect(stdout).toContain("batch timeout");
    expect(stdout).toContain("dry-run");
    expect(countTasks()).toEqual({ orphan: 3, total: 4 });
  });

  it("--apply：删 3 条孤儿（含巨批残骸），entry 存活的正常任务保留；自动备份", async () => {
    const { stdout } = await execFileAsync("node", [SCRIPT, `--db=${dbPath}`, "--apply"]);
    expect(stdout).toContain("已删除孤儿任务 3 条");
    expect(stdout).toContain("已备份");
    expect(countTasks()).toEqual({ orphan: 0, total: 1 });
    // entry 存活的正常任务保留
    const forms = db.prepare(`
      SELECT entry_id, last_error FROM embedding_tasks
    `).all() as Array<{ entry_id: string; last_error: string | null }>;
    expect(forms).toHaveLength(1);
    expect(forms[0].entry_id).toBe("e1");
    // memory_entries 数据不受影响
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number }).n).toBe(2);
    // 备份文件存在
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith("test.db.bak-embed-ghost"));
    expect(backups.length).toBe(1);
  });
});
