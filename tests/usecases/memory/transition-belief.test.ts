import { describe, it, expect } from "vitest";
import { TransitionBelief } from "@usecases/memory/transition-belief";
import { DomainError } from "@entities/errors";
import type { MemoryEntry } from "@entities/memory/memory-entry";

function makeBelief(id: string, status: string, createdAt = "2026-11-18T00:00:00Z"): MemoryEntry {
  return {
    id,
    layer: "working",
    contentType: "belief",
    sourceId: id,
    sourceTable: "belief",
    conversationId: "conv-1",
    granularity: "coarse",
    content: `belief ${id}`,
    metadata: { kind: "state", status, anchors: ["anchor-1"], inferredFrom: ["anchor-1"] },
    createdAt,
  };
}

function setup(entry: MemoryEntry | null) {
  const replaced: MemoryEntry[] = [];
  const uc = new TransitionBelief({
    getEntryById: async () => entry,
    replaceEntry: async (e) => { replaced.push(e); return { embeddingKept: false }; },
  });
  return { uc, replaced };
}

describe("TransitionBelief（F20261118bltls P1c）", () => {
  it("recorded → verified 合法迁移，保持 id 原地替换", async () => {
    const entry = makeBelief("b1", "recorded");
    const { uc, replaced } = setup(entry);
    const r = await uc.execute({ entryId: "b1", to: "verified" });
    expect(r).toEqual({ entryId: "b1", from: "recorded", to: "verified" });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].id).toBe("b1");
    expect((replaced[0].metadata as { status: string }).status).toBe("verified");
    // 其余字段不被动
    expect(replaced[0].content).toBe(entry.content);
    expect(replaced[0].createdAt).toBe(entry.createdAt);
  });

  it("同状态幂等不写库", async () => {
    const entry = makeBelief("b1", "verified");
    const { uc, replaced } = setup(entry);
    const r = await uc.execute({ entryId: "b1", to: "verified" });
    expect(r.from).toBe("verified");
    expect(r.to).toBe("verified");
    expect(replaced).toHaveLength(0);
  });

  it("superseded 终态无出边（verified → superseded 仅一条合法路径）", async () => {
    // verified → superseded 合法；反向 superseded → verified 非法
    const { uc } = setup(makeBelief("b1", "superseded"));
    await expect(uc.execute({ entryId: "b1", to: "verified" })).rejects.toThrow(DomainError);
  });

  it("非 belief 条目拒绝迁移", async () => {
    const entry = makeBelief("b1", "recorded");
    entry.contentType = "message";
    const { uc } = setup(entry);
    await expect(uc.execute({ entryId: "b1", to: "verified" })).rejects.toThrow(/不是 belief/);
  });

  it("条目不存在拒绝", async () => {
    const { uc } = setup(null);
    await expect(uc.execute({ entryId: "ghost", to: "verified" })).rejects.toThrow(/不存在/);
  });

  it("metadata 畸形（非 belief 契约）拒绝迁移", async () => {
    const entry = makeBelief("b1", "recorded");
    entry.metadata = { kind: "state" }; // 缺 status/anchors
    const { uc } = setup(entry);
    await expect(uc.execute({ entryId: "b1", to: "verified" })).rejects.toThrow(/metadata 不合法/);
  });
});