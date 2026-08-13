/**
 * F20260813mrel: 记忆关系层集成测试
 * 覆盖：createEdge 幂等/自环、getEdgesByEntry 方向/relates-to 双向、deleteEdgesByEntryIds、
 *       CreateEdge coarse 校验、GetRelated BFS/path 结构/环安全
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { initSchema } from "@frameworks/db/schema";
import { CreateEdge } from "@usecases/memory/create-edge";
import { GetRelated } from "@usecases/memory/get-related";
import { DeleteEdge } from "@usecases/memory/delete-edge";
import { createTestLogger } from "../../../helpers/logger";
import type DatabaseType from "better-sqlite3";
import type { MemoryEntry } from "@entities/memory/memory-entry";

let db: DatabaseType.Database;
let repo: SqliteMemoryRepository;
let createEdge: CreateEdge;
let getRelated: GetRelated;
let deleteEdge: DeleteEdge;

const logger = createTestLogger();

beforeAll(() => {
  db = new Database(":memory:");
  initSchema(db);
  repo = new SqliteMemoryRepository(db);
  createEdge = new CreateEdge(repo, logger);
  getRelated = new GetRelated(repo);
  deleteEdge = new DeleteEdge(repo);
});

afterAll(() => {
  db.close();
});

/** 写一条 coarse entry */
async function insertEntry(id: string, content: string, opts?: Partial<MemoryEntry>): Promise<void> {
  const entry: MemoryEntry = {
    id,
    layer: opts?.layer ?? "working",
    contentType: opts?.contentType ?? "message",
    sourceId: opts?.sourceId ?? id,
    sourceTable: opts?.sourceTable ?? "messages",
    conversationId: opts?.conversationId ?? null,
    granularity: opts?.granularity ?? "coarse",
    content,
    metadata: opts?.metadata ?? null,
    createdAt: opts?.createdAt ?? "2026-08-13T00:00:00Z",
  };
  await repo.storeEntry(entry);
}

describe("F20260813mrel: memory_edges 表 + CreateEdge", () => {
  it("createEdge 成功建边", async () => {
    await insertEntry("msg-a", "讨论 A");
    await insertEntry("doc-b", "文档 B", { contentType: "feature", sourceTable: "features" });

    const edgeId = await createEdge.execute({
      fromEntryId: "msg-a", toEntryId: "doc-b", edgeType: "produced",
    });
    expect(edgeId).toBeTruthy();
  });

  it("幂等：同 from+to+type 返回同一 edge id", async () => {
    const id1 = await createEdge.execute({
      fromEntryId: "msg-a", toEntryId: "doc-b", edgeType: "produced",
    });
    const id2 = await createEdge.execute({
      fromEntryId: "msg-a", toEntryId: "doc-b", edgeType: "produced",
    });
    expect(id1).toBe(id2);
  });

  it("自环拒绝", async () => {
    await expect(createEdge.execute({
      fromEntryId: "msg-a", toEntryId: "msg-a", edgeType: "relates-to",
    })).rejects.toThrow();
  });

  it("D3: fine 粒度 entry（chunk）拒绝建边", async () => {
    await insertEntry("chunk-1", "chunk 内容", { granularity: "fine", contentType: "feature_chunk" });
    await expect(createEdge.execute({
      fromEntryId: "msg-a", toEntryId: "chunk-1", edgeType: "references",
    })).rejects.toThrow();
  });

  it("不存在 entry 拒绝建边", async () => {
    await expect(createEdge.execute({
      fromEntryId: "nonexistent", toEntryId: "msg-a", edgeType: "references",
    })).rejects.toThrow();
  });
});

describe("F20260813mrel: getEdgesByEntry + GetRelated", () => {
  beforeAll(async () => {
    // 补充更多边用于 BFS 测试
    // msg-a produced doc-b (已建)
    // doc-b references doc-c
    await insertEntry("doc-c", "文档 C", { contentType: "feature", sourceTable: "features" });
    await createEdge.execute({
      fromEntryId: "doc-b", toEntryId: "doc-c", edgeType: "references",
    });
    // msg-d relates-to msg-a（双向）
    await insertEntry("msg-d", "讨论 D");
    await createEdge.execute({
      fromEntryId: "msg-d", toEntryId: "msg-a", edgeType: "relates-to",
    });
  });

  it("getRelated out 方向返回出边邻居", async () => {
    const results = await getRelated.execute({ entryId: "msg-a", direction: "out" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const docB = results.find(r => r.entry.id === "doc-b");
    expect(docB).toBeDefined();
    expect(docB!.edgeType).toBe("produced");
    expect(docB!.edgeFromEntryId).toBe("msg-a");
    expect(docB!.depth).toBe(1);
  });

  it("getRelated in 方向返回入边邻居", async () => {
    const results = await getRelated.execute({ entryId: "doc-b", direction: "in" });
    const msgA = results.find(r => r.entry.id === "msg-a");
    expect(msgA).toBeDefined();
    expect(msgA!.edgeType).toBe("produced");
  });

  it("D4: relates-to 自动双向查", async () => {
    // msg-d relates-to msg-a。从 msg-a 查出边也应看到 msg-d（双向语义）
    const results = await getRelated.execute({
      entryId: "msg-a",
      edgeTypes: ["relates-to"],
      direction: "out",
    });
    const msgD = results.find(r => r.entry.id === "msg-d");
    expect(msgD).toBeDefined();
    expect(msgD!.edgeType).toBe("relates-to");
  });

  it("BFS depth=2 返回两跳邻居", async () => {
    // msg-a →(produced)→ doc-b →(references)→ doc-c
    const results = await getRelated.execute({ entryId: "msg-a", depth: 2, direction: "out" });
    const docC = results.find(r => r.entry.id === "doc-c");
    expect(docC).toBeDefined();
    expect(docC!.depth).toBe(2);
  });

  it("path 结构含 entry + edgeType + edgeFromEntryId + depth", async () => {
    const results = await getRelated.execute({ entryId: "msg-a" });
    for (const r of results) {
      expect(r.entry).toBeDefined();
      expect(r.entry.id).toBeTruthy();
      expect(r.edgeType).toBeTruthy();
      expect(r.edgeFromEntryId).toBeTruthy();
      expect(typeof r.depth).toBe("number");
    }
  });

  it("环安全：A→B→A 不无限循环", async () => {
    // 建 A→B 和 B→A 环
    await insertEntry("loop-a", "loop A");
    await insertEntry("loop-b", "loop B");
    await createEdge.execute({ fromEntryId: "loop-a", toEntryId: "loop-b", edgeType: "relates-to" });
    await createEdge.execute({ fromEntryId: "loop-b", toEntryId: "loop-a", edgeType: "relates-to" });

    const results = await getRelated.execute({ entryId: "loop-a", depth: 10, edgeTypes: ["relates-to"] });
    // 不会无限循环——visited 守门
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe("F20260813mrel: DeleteEdge", () => {
  it("删除边后 getRelated 不再返回", async () => {
    await insertEntry("del-a", "del A");
    await insertEntry("del-b", "del B");
    const edgeId = await createEdge.execute({
      fromEntryId: "del-a", toEntryId: "del-b", edgeType: "relates-to",
    });

    // 删前能查到
    const before = await getRelated.execute({ entryId: "del-a", edgeTypes: ["relates-to"] });
    expect(before.length).toBeGreaterThanOrEqual(1);

    await deleteEdge.execute(edgeId);

    // 删后查不到
    const after = await getRelated.execute({ entryId: "del-a", edgeTypes: ["relates-to"] });
    expect(after.find(r => r.entry.id === "del-b")).toBeUndefined();
  });

  it("幂等：删不存在的 edge id 静默返回", async () => {
    // DeleteEdge 幂等——与工具描述"删不存在的 edge_id 不报错"一致
    await expect(deleteEdge.execute("nonexistent-edge")).resolves.toBeUndefined();
  });
});

describe("F20260813mrel: deleteEdgesByEntryIds CASCADE 清理", () => {
  it("删 entry 后其关联边被清理", async () => {
    await insertEntry("cascade-a", "cascade A");
    await insertEntry("cascade-b", "cascade B");
    await createEdge.execute({
      fromEntryId: "cascade-a", toEntryId: "cascade-b", edgeType: "relates-to",
    });

    // 确认边存在
    const before = await getRelated.execute({ entryId: "cascade-a", edgeTypes: ["relates-to"] });
    expect(before.find(r => r.entry.id === "cascade-b")).toBeDefined();

    // 通过 deleteBySource 删 entry（触发边清理）
    await repo.deleteBySource("messages", "cascade-a");

    // 边也被清理了
    const after = await getRelated.execute({ entryId: "cascade-b", edgeTypes: ["relates-to"] });
    expect(after.find(r => r.entry.id === "cascade-a")).toBeUndefined();
  });
});
