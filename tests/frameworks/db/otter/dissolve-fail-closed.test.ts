/**
 * #1403：otter 仓 dissolve 对不存在 ID fail-closed（#1370 族模式口径外收尾，真 sqlite）。
 *
 * 上游 dissolve-otter.ts 有 getById + canDissolveOtter 双层前置防护，
 * 本用例锁 repo 层兜底：changes=0 时不静默成功，抛错走 assertUpdated 统一口径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { createTestDb } from "../../../helpers/db";

function insertOtter(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO otters (id, name, type, created_at)
    VALUES (?, 'test-otter', 'assistant', '2026-01-01T00:00:00Z')
  `).run(id);
}

describe("SqliteOtterRepository.dissolve fail-closed（#1403）", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteOtterRepository(db);
  });
  afterEach(() => { db.close(); });

  it("不存在的 ID：抛错（changes=0 不静默成功）", async () => {
    await expect(repo.dissolve("otter-nonexistent", "2026-10-09T00:00:00Z"))
      .rejects.toThrow(/otter 不存在/);
  });

  it("存在的 ID：正常 dissolve 不回归", async () => {
    insertOtter(db, "otter-1");
    await repo.dissolve("otter-1", "2026-10-09T00:00:00Z");
    const otter = await repo.getById("otter-1");
    expect(otter?.status).toBe("dissolved");
    expect(otter?.dissolvedAt).toBe("2026-10-09T00:00:00Z");
  });
});
