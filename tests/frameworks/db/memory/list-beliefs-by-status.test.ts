/**
 * F20261118nrcst P2b1：MemoryReader.listBeliefsByStatus 集成测试。
 *
 * 覆盖：状态过滤（json_extract metadata.status）、时间闭区间 [after, through]、
 *       created_at 升序、无误命中其他 content_type 或可见性无关的状态。
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import type { MemoryEntry } from "@entities/memory/memory-entry";

function makeBelief(id: string, status: string, createdAt: string): MemoryEntry {
  return {
    id,
    layer: "working",
    contentType: "belief",
    sourceId: id,
    sourceTable: "belief",
    conversationId: null,
    granularity: "coarse",
    content: `belief ${id}`,
    metadata: { kind: "state", status, anchors: ["anchor-1"], inferredFrom: ["anchor-1"] },
    createdAt,
  };
}

describe("SqliteMemoryRepository.listBeliefsByStatus（F20261118nrcst P2b1）", () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db);
    repo = new SqliteMemoryRepository(db);
    await repo.storeEntry(makeBelief("b1", "recorded", "2026-11-18T08:00:00Z"));
    await repo.storeEntry(makeBelief("b2", "recorded", "2026-11-18T10:00:00Z"));
    await repo.storeEntry(makeBelief("b3", "verified", "2026-11-18T09:00:00Z"));
    // 非 belief 条目：不应命中
    await repo.storeEntry({
      id: "msg-1",
      layer: "working",
      contentType: "message",
      sourceId: "msg-1",
      sourceTable: "messages",
      conversationId: null,
      granularity: "coarse",
      content: "普通消息",
      metadata: null,
      createdAt: "2026-11-18T08:30:00Z",
    });
  });

  it("按状态过滤：只回 recorded 的 belief，created_at 升序", async () => {
    const list = await repo.listBeliefsByStatus("recorded", "2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z");
    expect(list.map((e) => e.id)).toEqual(["b1", "b2"]);
  });

  it("时间闭区间 [after, through] 严格生效", async () => {
    const list = await repo.listBeliefsByStatus("recorded", "2026-11-18T09:00:00Z", "2026-11-18T10:00:00Z");
    expect(list.map((e) => e.id)).toEqual(["b2"]);
  });

  it("起始时间边界（<= after 被排除）", async () => {
    const list = await repo.listBeliefsByStatus("recorded", "2026-11-18T08:00:01Z", "2026-11-19T00:00:00Z");
    expect(list.map((e) => e.id)).toEqual(["b2"]);
  });

  it("verified 状态同样可查（区间过滤互不串态）", async () => {
    const list = await repo.listBeliefsByStatus("verified", "2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z");
    expect(list.map((e) => e.id)).toEqual(["b3"]);
  });

  it("空区间返回空数组（不抛错）", async () => {
    const list = await repo.listBeliefsByStatus("recorded", "2026-11-19T00:00:00Z", "2026-11-19T08:00:00Z");
    expect(list).toEqual([]);
  });

  it("区间内缺 status 元数据的 belief 行 fail-loud（不静默丢审）", async () => {
    // 旁路写入：belief content_type 但 metadata 无 status（今天唯一写者给足了 status，此行为未来防线）
    await repo.storeEntry({
      id: "b-corrupt",
      layer: "working",
      contentType: "belief",
      sourceId: "b-corrupt",
      sourceTable: "belief",
      conversationId: null,
      granularity: "coarse",
      content: "缺 status 的 belief",
      metadata: { kind: "state", anchors: ["anchor-1"] },
      createdAt: "2026-11-18T10:30:00Z",
    });
    await expect(
      repo.listBeliefsByStatus("recorded", "2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"),
    ).rejects.toThrow(/b-corrupt/);
  });
});