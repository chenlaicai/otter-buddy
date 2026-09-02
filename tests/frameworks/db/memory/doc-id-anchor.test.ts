/**
 * F20260902rcq3 单测：doc ID 锚点注入
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: crypto.randomUUID(), layer: "document", contentType: "feature",
    sourceId: "F20260829raft", sourceTable: "features",
    conversationId: null, granularity: "fine", content: "海獭 raft 集体名词意象设计",
    metadata: null, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("F20260902rcq3 doc ID 锚点注入", () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    repo = new SqliteMemoryRepository(db);
  });

  it("feature 条目 FTS 索引含 sourceId（正文不含自身编号也能被 ID 直查）", async () => {
    await repo.storeEntry(makeEntry());
    const hit = db.prepare(
      `SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_fts_jieba MATCH '"F20260829raft"'`,
    ).get() as { c: number };
    expect(hit.c).toBeGreaterThanOrEqual(1);
  });

  it("research 条目同样注入；message 条目不注入", async () => {
    await repo.storeEntry(makeEntry({ sourceTable: "research", sourceId: "R20260829hidx", contentType: "research" }));
    await repo.storeEntry(makeEntry({ sourceTable: "messages", sourceId: crypto.randomUUID(), contentType: "message", layer: "historical" }));
    const r = db.prepare(`SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_fts_jieba MATCH '"R20260829hidx"'`).get() as { c: number };
    expect(r.c).toBeGreaterThanOrEqual(1);
    // message 行不含 feature 编号（只有 feature 注入了，research 用的是自己的编号）
    const m = db.prepare(`SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_fts_jieba MATCH '"F20260829raft"'`).get() as { c: number };
    expect(m.c).toBe(0);
  });

  it("content 本体不被修改（只注入 FTS，原文保持）", async () => {
    const e = makeEntry();
    await repo.storeEntry(e);
    const row = db.prepare("SELECT content FROM memory_entries WHERE id=?").get(e.id) as { content: string };
    expect(row.content).toBe("海獭 raft 集体名词意象设计"); // 无 ID 前缀
  });
});
