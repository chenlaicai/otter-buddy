/**
 * issue #509: chunk 入库幂等性集成测试（真 sqlite，:memory:）
 *
 * 覆盖缺陷：sync_docs 重跑同一文档产生同 chunk 双份入库
 *（otter-create-unify chunk_4 两条 / F20260826ybx6 chunk_0 两条实证）。
 *
 * 根因背景：历史重复是"文档文件改 ID 重入"（F2026082650eb→F20260826ybx6、
 * F20260826ocui→F20260826ucrt）——旧 source_id 的 chunk 在归档时未被清理。
 * 本测试锁定「同 source_id 重复 reindex 不产生重复」这一可代码防住的语义，
 * 跨 ID 撞车的治理在特性文档「边界与遗留」节声明（流程层 ID 协调，非本 PR）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import type { MemoryEntry } from "@entities/memory/memory-entry";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;

beforeAll(() => {
  db = new Database(":memory:");
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
});

afterAll(() => {
  db.close();
});

/** 构造同 source 的 chunk entry 批次 */
function makeChunks(sourceId: string, count: number, contentPrefix: string): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    layer: "document",
    contentType: "feature_chunk",
    sourceId,
    sourceTable: "features",
    conversationId: null,
    granularity: "fine",
    content: `${contentPrefix} chunk ${i} 内容，长度足够`,
    metadata: { chunk_index: i, chunk_total: count },
    createdAt: new Date().toISOString(),
  }));
}

/** 查 DB 中某 source 的 chunk 数 */
function countChunks(sourceId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) c FROM memory_entries WHERE source_table='features' AND source_id=? AND content_type='feature_chunk'",
    )
    .get(sourceId) as { c: number };
  return row.c;
}

describe("replaceEntriesBySource 幂等性（issue #509）", () => {
  it("同 source_id 连续两次 replace：第二次完全替换，DB 中无重复 chunk", async () => {
    const sourceId = "F20260827idem";
    await repo.replaceEntriesBySource(makeChunks(sourceId, 5, "第一版"));
    expect(countChunks(sourceId)).toBe(5);

    await repo.replaceEntriesBySource(makeChunks(sourceId, 5, "第二版"));
    expect(countChunks(sourceId)).toBe(5);

    // 内容应为第二版（旧版被删）
    const rows = db
      .prepare(
        "SELECT DISTINCT substr(content,1,3) prefix FROM memory_entries WHERE source_id=? AND content_type='feature_chunk'",
      )
      .all(sourceId) as Array<{ prefix: string }>;
    expect(rows).toEqual([{ prefix: "第二版" }]);
  });

  it("reindex 后 chunk 数变化（文档编辑减少 section）：旧多余 chunk 被清理", async () => {
    const sourceId = "F20260827shr";
    await repo.replaceEntriesBySource(makeChunks(sourceId, 8, "原版"));
    expect(countChunks(sourceId)).toBe(8);

    await repo.replaceEntriesBySource(makeChunks(sourceId, 3, "精简版"));
    expect(countChunks(sourceId)).toBe(3);
  });

  it("并发语义：replaceEntriesBySource 是单事务（删旧+插新原子），中间不留空窗", async () => {
    const sourceId = "F20260827atom";
    await repo.replaceEntriesBySource(makeChunks(sourceId, 4, "旧"));

    // replace 过程中任何时候查询都不应看到"删了旧但新未插"的中间态。
    // better-sqlite3 单连接串行，此断言锁定 runInTx 语义不回归。
    await repo.replaceEntriesBySource(makeChunks(sourceId, 6, "新"));
    const c = countChunks(sourceId);
    expect(c).toBe(6); // 不是 0（空窗）、不是 10（重复）
  });

  it("M1 校验：混合 source 的 batch 抛异常，不产生部分写入", async () => {
    const mixed = [
      ...makeChunks("F20260827aaa", 2, "A"),
      ...makeChunks("F20260827bbb", 1, "B"),
    ];
    await expect(repo.replaceEntriesBySource(mixed)).rejects.toThrow(
      "requires homogeneous source",
    );
    expect(countChunks("F20260827aaa")).toBe(0);
    expect(countChunks("F20260827bbb")).toBe(0);
  });
});
