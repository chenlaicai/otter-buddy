/**
 * F20260811mrpy Part 1：SqliteMemoryRepository 暗化条目扫描 + vec 覆盖率接口测试
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import type DatabaseType from "better-sqlite3";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

beforeAll(() => {
  db = new Database(":memory:");
  try { loadSqliteVec(db); } catch { /* vitest 环境无扩展则跳过 vec 测试 */ }
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
});

afterAll(() => {
  db.close();
});

describe("SqliteMemoryRepository - F20260811mrpy Part 1 暗化/覆盖率", () => {
  it("hasEmbeddings 空数组返回空 Map", async () => {
    const result = await repo.hasEmbeddings([]);
    expect(result.size).toBe(0);
  });

  it("hasEmbeddings 反映每条 entry 的 vec 索引状态", async () => {
    // 写 2 条 entry + 1 个 vec 索引
    db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, granularity, content, metadata, created_at)
      VALUES
        ('e1', 'working', 'message', 's1', 'messages', NULL, 'fine', 'content-1', NULL, '2026-08-11T00:00:00Z'),
        ('e2', 'working', 'message', 's2', 'messages', NULL, 'fine', 'content-2', NULL, '2026-08-11T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO memory_vec (memory_entry_id, embedding)
      VALUES ('e1', ?)
    `).run(Buffer.from(new Float32Array(1024).buffer));

    const result = await repo.hasEmbeddings(["e1", "e2"]);
    expect(result.get("e1")).toBe(true);
    expect(result.get("e2")).toBe(false);
  });

  it("scanDarkEntries 返回无 vec 索引的条目", async () => {
    const result = await repo.scanDarkEntries();
    expect(result.total).toBe(1);
    expect(result.entries[0].entryId).toBe("e2");
    expect(result.vecDisabled).toBe(false);
  });

  it("scanDarkEntries 在 disableVec 后清表并返回全表暗化 vecDisabled=true", async () => {
    // F20260812mrcq Part 0：disableVec 同步清 memory_vec 表；
    // scanDarkEntries 用 vecTableExists 守卫（不受 hasVec 影响），仍能检测全表暗化。
    repo.disableVec();
    const result = await repo.scanDarkEntries();
    // 清表后 e1 也失去 vec，加上原本无 vec 的 e2，共 2 条暗化
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.vecDisabled).toBe(true);
  });

  it("F20260812mrcq Part 0: disableVec 后 vecTableExists 不变（物理表还在）", async () => {
    // disableVec 前已清表，再次调用验证 vecTableExists 不变
    const before = repo.hasVecTable();
    repo.disableVec();
    const after = repo.hasVecTable();
    expect(before).toBe(true);
    expect(after).toBe(true);  // 物理表存在不受 disableVec 影响
    expect(repo.isVecEnabled()).toBe(false);  // 但运行时禁用
  });

  it("hasEmbeddings 在 disableVec 后所有 entry 返回 false", async () => {
    repo.disableVec();
    const result = await repo.hasEmbeddings(["e1", "e2"]);
    expect(result.get("e1")).toBe(false);
    expect(result.get("e2")).toBe(false);
  });
});

describe("SqliteMemoryRepository - F20260811mrpy Part 3 embedding_meta", () => {
  it("getEmbeddingMeta 初次返回空对象", async () => {
    const freshDb = new Database(":memory:");
    initSchema(freshDb);
    const freshRepo = new SqliteMemoryRepository(freshDb);
    const meta = await freshRepo.getEmbeddingMeta();
    expect(meta).toEqual({});
    freshDb.close();
  });

  it("setEmbeddingMeta 后 getEmbeddingMeta 返回写入值", async () => {
    const freshDb = new Database(":memory:");
    initSchema(freshDb);
    const freshRepo = new SqliteMemoryRepository(freshDb);
    await freshRepo.setEmbeddingMeta({
      modelId: "Xenova/bge-m3",
      modelRev: "abc123",
      dim: 1024,
    });
    const meta = await freshRepo.getEmbeddingMeta();
    expect(meta).toEqual({
      modelId: "Xenova/bge-m3",
      modelRev: "abc123",
      dim: 1024,
    });
    freshDb.close();
  });

  it("setEmbeddingMeta 重复调用覆盖旧值", async () => {
    const freshDb = new Database(":memory:");
    initSchema(freshDb);
    const freshRepo = new SqliteMemoryRepository(freshDb);
    await freshRepo.setEmbeddingMeta({ modelId: "old-model", modelRev: "v1", dim: 512 });
    await freshRepo.setEmbeddingMeta({ modelId: "new-model", modelRev: "v2", dim: 1024 });
    const meta = await freshRepo.getEmbeddingMeta();
    expect(meta.modelId).toBe("new-model");
    expect(meta.dim).toBe(1024);
    freshDb.close();
  });
});
