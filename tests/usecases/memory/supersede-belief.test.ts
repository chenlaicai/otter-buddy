import { describe, it, expect } from "vitest";
import { SupersedeBelief } from "@usecases/memory/supersede-belief";
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

function statusOf(entries: Map<string, MemoryEntry>, id: string): string {
  return (entries.get(id)!.metadata as { status: string }).status;
}

function setup() {
  const entries = new Map<string, MemoryEntry>();
  entries.set("old", makeBelief("old", "recorded"));
  entries.set("new", makeBelief("new", "recorded"));
  const supersededBy = new Map<string, string>();
  const createdEdges: Array<{ from: string; to: string }> = [];
  const transition = new TransitionBelief({
    getEntryById: async (id) => entries.get(id) ?? null,
    replaceEntry: async (e) => { entries.set(e.id, e); return { embeddingKept: false }; },
  });
  const uc = new SupersedeBelief({
    getSupersededBy: async (ids) => {
      const m = new Map<string, string>();
      for (const id of ids) if (supersededBy.has(id)) m.set(id, supersededBy.get(id)!);
      return m;
    },
    createEdge: async ({ fromEntryId, toEntryId }) => {
      const id = `edge-${fromEntryId}-${toEntryId}`;
      createdEdges.push({ from: fromEntryId, to: toEntryId });
      return id;
    },
    getEntryById: async (id) => entries.get(id) ?? null,
  }, transition);
  return { uc, entries, supersededBy, createdEdges };
}

describe("SupersedeBelief（F20261118bltls P1c）", () => {
  it("markExpired：旧条目迁 superseded，不建边", async () => {
    const { uc, entries, createdEdges } = setup();
    await uc.markExpired("old");
    expect(statusOf(entries, "old")).toBe("superseded");
    expect(createdEdges).toHaveLength(0);
  });

  it("markReplaced：旧迁 superseded + 建边 from=new, to=old", async () => {
    const { uc, entries, createdEdges } = setup();
    const r = await uc.markReplaced("old", "new", "otter-1");
    expect(statusOf(entries, "old")).toBe("superseded");
    expect(r.edgeId).toBe("edge-new-old");
    expect(createdEdges).toEqual([{ from: "new", to: "old" }]);
  });

  it("TOCTOU：old 已有入边 supersedes → 幂等跳过不重复建边", async () => {
    const { uc, supersededBy, createdEdges, entries } = setup();
    supersededBy.set("old", "earlier-new");
    const r = await uc.markReplaced("old", "new");
    expect(r.alreadySuperseded).toBe(true);
    expect(createdEdges).toHaveLength(0);
    expect(statusOf(entries, "old")).toBe("recorded"); // 未被本次迁移改写
  });

  it("新条目不存在或非 belief 拒绝建边", async () => {
    const { uc, entries } = setup();
    entries.delete("new");
    await expect(uc.markReplaced("old", "new")).rejects.toThrow(DomainError);
    entries.set("new", { ...makeBelief("new", "recorded"), contentType: "message" });
    await expect(uc.markReplaced("old", "new")).rejects.toThrow(/不是 belief/);
  });
});