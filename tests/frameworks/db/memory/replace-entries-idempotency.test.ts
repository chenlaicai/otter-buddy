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

/** F20261110dsqci：查某 entry 的卫星数据存在性（fts/weights——复用语义的保留对象） */
function satellitesOf(entryId: string): { fts: number; weights: number } {
  const fts = (db.prepare("SELECT COUNT(*) c FROM memory_fts_jieba WHERE memory_entry_id=?").get(entryId) as { c: number }).c;
  const weights = (db.prepare("SELECT COUNT(*) c FROM memory_weights WHERE memory_entry_id=?").get(entryId) as { c: number }).c;
  return { fts, weights };
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

describe("replaceEntriesBySource 复用语义（F20261110dsqci / #1818）", () => {
  it("reuseEntryIds 内的 entry：id/created_at 保留 + 卫星数据（fts/weights）不删 + metadata 被更新", async () => {
    const sourceId = "F20261110reuse1";
    const first = makeChunks(sourceId, 3, "原版");
    await repo.replaceEntriesBySource(first);
    // 记住第一个 chunk 的 id/created_at 与卫星数据
    const keep = first[0];
    const before = satellitesOf(keep.id);
    expect(before.fts).toBe(1);
    expect(before.weights).toBe(1);

    // 第二版：content 不变（同 keep），仅 chunk_index 环境字段漂移；复用 keep.id
    const second = makeChunks(sourceId, 3, "原版");
    second[0] = { ...keep, metadata: { chunk_index: 9, chunk_total: 3 } };
    await repo.replaceEntriesBySource(second, { reuseEntryIds: new Set([keep.id]) });

    // id 保留（未删未重建）、卫星数据保留、metadata 更新为漂移后的值
    const row = db.prepare("SELECT * FROM memory_entries WHERE id=?").get(keep.id) as { metadata: string; created_at: string };
    expect(row).toBeTruthy();
    expect(row.created_at).toBe(keep.createdAt);
    expect(JSON.parse(row.metadata)).toMatchObject({ chunk_index: 9 });
    const after = satellitesOf(keep.id);
    expect(after).toEqual(before);
    expect(countChunks(sourceId)).toBe(3); // 无重复
  });

  it("reuseEntryIds 外的同 source 旧 chunk：照旧删旧插新（卫星数据清理）", async () => {
    const sourceId = "F20261110reuse2";
    const first = makeChunks(sourceId, 3, "旧版");
    await repo.replaceEntriesBySource(first);
    const gone = first[1];

    // 第二版全部新建（不复用）——旧三个应全删
    const second = makeChunks(sourceId, 2, "新版");
    await repo.replaceEntriesBySource(second, { reuseEntryIds: new Set() });

    expect(db.prepare("SELECT COUNT(*) c FROM memory_entries WHERE id=?").get(gone.id as string)).toEqual({ c: 0 });
    expect(satellitesOf(gone.id).fts).toBe(0);
    expect(satellitesOf(gone.id).weights).toBe(0);
    expect(countChunks(sourceId)).toBe(2);
  });

  it("不传 opts：保持旧语义（全删全插），存量调用方零破坏", async () => {
    const sourceId = "F20261110reuse3";
    await repo.replaceEntriesBySource(makeChunks(sourceId, 3, "v1"));
    await repo.replaceEntriesBySource(makeChunks(sourceId, 3, "v1"));
    expect(countChunks(sourceId)).toBe(3);
  });

  it("findEntriesBySourceAndType：返回同 source+type 全部 entry（含 metadata），其它 type 不泄入", async () => {
    const sourceId = "F20261110find1";
    const chunks = makeChunks(sourceId, 2, "定位");
    await repo.replaceEntriesBySource(chunks);
    // 插一个同 source 的 summary entry（content_type 不同，不应返回）
    await repo.storeEntry({
      id: sourceId, layer: "document", contentType: "feature", sourceId,
      sourceTable: "features", conversationId: null, granularity: "coarse",
      content: "摘要内容足够长", metadata: null, createdAt: new Date().toISOString(),
    });

    const found = await repo.findEntriesBySourceAndType("features", sourceId, "feature_chunk");
    expect(found).toHaveLength(2);
    expect(found.every(e => e.contentType === "feature_chunk" && e.metadata && typeof e.metadata === "object")).toBe(true);
  });
});
