import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { createTestDb } from "../helpers/db";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

vi.setConfig({ testTimeout: 20_000 });

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUDIT_SCRIPT = path.join(ROOT, "scripts/audit-memory-vec.mjs");
const CLEANUP_SCRIPT = path.join(ROOT, "scripts/cleanup-memory-vec.mjs");
const SECRET = "script-output-must-not-contain-memory-body";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;
let repo: SqliteMemoryRepository;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-vec-hygiene-"));
  dbPath = path.join(tmpDir, "test.db");
  db = createTestDb(dbPath);
  db.pragma("journal_mode = WAL");
  repo = new SqliteMemoryRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function addLiveEntry(id: string): Promise<void> {
  const entry: MemoryEntry = {
    id, layer: "working", contentType: "message", sourceId: id, sourceTable: "entries",
    conversationId: null, granularity: "fine", content: SECRET, metadata: null,
    createdAt: "2026-11-26T00:00:00.000Z",
  };
  const version = await repo.storeEntry(entry);
  await repo.storeEmbedding(id, version.generation, version.contentHash, new Float32Array(1024).fill(0.25));
}

function addOrphan(id: string): void {
  db.prepare("INSERT INTO memory_vec (memory_entry_id, embedding) VALUES (?, ?)")
    .run(id, new Float32Array(1024).fill(0.5));
}

async function runScript(script: string, ...args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], { cwd: ROOT });
  expect(stdout).not.toContain(SECRET);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("memory_vec 审计/清理脚本（/tmp 真实 DB）", () => {
  it("audit 与 cleanup dry-run 均为只读，报告孤儿且不创建备份", async () => {
    await addLiveEntry("live-1");
    addOrphan("orphan-1");

    const audit = await runScript(AUDIT_SCRIPT, `--db=${dbPath}`);
    expect(audit).toMatchObject({ mode: "read-only", total: 2, live: 1, orphan: 1, orphanRatio: 0.5 });
    const dryRun = await runScript(CLEANUP_SCRIPT, `--db=${dbPath}`);
    expect(dryRun).toMatchObject({ mode: "dry-run", total: 2, live: 1, orphan: 1, orphanRatio: 0.5 });

    expect(db.prepare("SELECT memory_entry_id FROM memory_vec ORDER BY memory_entry_id").all())
      .toEqual([{ memory_entry_id: "live-1" }, { memory_entry_id: "orphan-1" }]);
    expect(fs.readdirSync(tmpDir).filter(name => name.includes("bak-vec-hygiene"))).toEqual([]);
  });

  it("apply 的 SQLite 备份含 WAL-only 数据，源库 orphan=0 且 live entry/vec 全保留", async () => {
    await addLiveEntry("live-1");
    await addLiveEntry("live-2");
    addOrphan("orphan-1");
    db.pragma("wal_checkpoint(TRUNCATE)");
    await addLiveEntry("live-wal-only");
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const backupPath = path.join(tmpDir, "consistent-backup.db");
    const applied = await runScript(CLEANUP_SCRIPT, `--db=${dbPath}`, "--apply", `--backup=${backupPath}`);
    expect(applied).toMatchObject({
      mode: "apply", backupPath, deleted: 1,
      before: { total: 4, live: 3, orphan: 1, orphanRatio: 0.25 },
      after: { total: 3, live: 3, orphan: 0, orphanRatio: 0 },
    });

    const sourceIds = db.prepare("SELECT id FROM memory_entries ORDER BY id").all() as Array<{ id: string }>;
    expect(sourceIds.map(row => row.id)).toEqual(["live-1", "live-2", "live-wal-only"]);
    expect(db.prepare("SELECT memory_entry_id FROM memory_vec ORDER BY memory_entry_id").all())
      .toEqual([{ memory_entry_id: "live-1" }, { memory_entry_id: "live-2" }, { memory_entry_id: "live-wal-only" }]);

    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      loadSqliteVec(backup);
      expect((backup.prepare("SELECT 1 FROM memory_entries WHERE id = 'live-wal-only'").get())).toBeDefined();
      expect((backup.prepare("SELECT COUNT(*) AS n FROM memory_vec").get() as { n: number }).n).toBe(4);
      expect((backup.prepare("SELECT 1 FROM memory_vec WHERE memory_entry_id = 'orphan-1'").get())).toBeDefined();
    } finally {
      backup.close();
    }
  });
});
