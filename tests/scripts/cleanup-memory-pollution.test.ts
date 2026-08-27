/**
 * issue #509 清理脚本集成测试（PR #519 审视发现 3 补充）。
 *
 * 在真实临时 DB 上注入模拟污染，验证：
 * 1. dry-run（默认）只报告不删除、不备份——安全设计的行为断言
 * 2. --apply 删除 A 类空 content + B 类旧重复 chunk（保留最新），且先自动备份
 *
 * 脚本用 execFile 真实执行（非 import），因为脚本是独立 mjs 进程入口。
 * 测试 schema 按脚本实际查询建模：chunk 存于 memory_entries（content_type=feature_chunk，
 * chunk_index 在 metadata JSON），孤儿判定 join features/research 表。
 *
 * lint-tests:allow-ddl——豁免理由：本测试验证的是独立运维脚本对「任意 DB」的行为，
 * 被测对象（cleanup-memory-pollution.mjs）不读生产 schema 迁移链，临时库手写 DDL 不构成
 * 与生产 schema 的漂移风险（与 migration.test.ts 建旧 schema 表同理）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(process.cwd(), "scripts/cleanup-memory-pollution.mjs");

function seedDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content_type TEXT NOT NULL,
      source_id TEXT,
      source_table TEXT,
      conversation_id TEXT,
      granularity TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      retrieval_count INTEGER DEFAULT 0,
      flagged INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE features (id TEXT PRIMARY KEY, title TEXT, status TEXT, file_path TEXT);
    CREATE TABLE research (id TEXT PRIMARY KEY, title TEXT, status TEXT, file_path TEXT);
    CREATE TABLE memory_weights (memory_entry_id TEXT);
    CREATE TABLE embedding_tasks (entry_id TEXT);
    CREATE TABLE memory_edges (from_entry_id TEXT, to_entry_id TEXT);
    CREATE TABLE memory_fts_jieba (memory_entry_id TEXT);
  `);

  const ins = db.prepare(
    `INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, content, metadata, created_at, updated_at)
     VALUES (?, 'document', ?, ?, 'features', ?, ?, ?, ?)`,
  );
  const old = "2026-08-01T00:00:00Z";
  const now = "2026-08-26T00:00:00Z";

  // A 类：空/纯空白 content 条目（注意：SQLite trim() 只去空格，纯空格串才可被 length=0 捕获）
  ins.run("empty-1", "feature_chunk", "F-doc-a", "", null, old, old);
  ins.run("empty-2", "feature_chunk", "F-doc-a", "   ", null, old, old);
  // 正常条目
  ins.run("good-1", "feature_chunk", "F-doc-a", "正常内容，长度足够，不应被清理", JSON.stringify({ chunk_index: 9 }), now, now);
  // B 类：同 (source_table, source_id, content_type, chunk_index) 重复，保留最新
  ins.run("dup-old", "feature_chunk", "F-doc-b", "同一段落", JSON.stringify({ chunk_index: 0 }), old, old);
  ins.run("dup-new", "feature_chunk", "F-doc-b", "同一段落", JSON.stringify({ chunk_index: 0 }), now, now);
  ins.run("uniq-1", "feature_chunk", "F-doc-b", "另一段落", JSON.stringify({ chunk_index: 1 }), now, now);
  db.close();
}

describe("cleanup-memory-pollution.mjs 集成（PR #519 审视补充）", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
    dbPath = path.join(tmpDir, "test.db");
    seedDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run（默认）：报告污染但不删除、不备份", async () => {
    const { stdout } = await execFileAsync("node", [SCRIPT, `--db=${dbPath}`]);
    expect(stdout).toMatch(/DRY-RUN/);

    const db = new Database(dbPath, { readonly: true });
    const count = (db.prepare("SELECT COUNT(*) c FROM memory_entries").get() as { c: number }).c;
    db.close();
    expect(count).toBe(6);

    // dry-run 不产生备份文件
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak"));
    expect(backups).toHaveLength(0);
  });

  it("--apply：删除空 content 与旧重复 chunk，保留正常数据，且先备份", async () => {
    const { stdout } = await execFileAsync("node", [SCRIPT, `--db=${dbPath}`, "--apply"]);

    const db = new Database(dbPath, { readonly: true });
    const entries = db.prepare("SELECT id FROM memory_entries ORDER BY id").all() as Array<{ id: string }>;
    db.close();

    // A 类空 content 已删；B 类保留最新 dup-new、删旧 dup-old；正常条目不动
    expect(entries.map((e) => e.id)).toEqual(["dup-new", "good-1", "uniq-1"]);

    // --apply 前自动备份（.bak-<timestamp> 落在 DB 同目录）
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes(".bak"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(stdout).toMatch(/已备份/);
  });
});
