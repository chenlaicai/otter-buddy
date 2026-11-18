/**
 * F20261118belif P1a：RecordBelief 写入路径测试（校验拒收 + 合法入库形态）。
 */
import { describe, it, expect } from "vitest";
import { BeliefGuard } from "@usecases/memory/belief-guard";
import type { BeliefGuardPorts, MessageSender } from "@usecases/memory/belief-guard";
import { RecordBelief } from "@usecases/memory/record-belief";
import type { BeliefStore } from "@usecases/memory/record-belief";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { parseBeliefMetadata } from "@entities/memory/belief";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-default", layer: "working", contentType: "message", sourceId: "src-1",
    sourceTable: "entries", conversationId: "conv-A", granularity: "fine",
    content: "测试内容", metadata: null, createdAt: "2026-09-01T00:00:00Z", ...overrides,
  };
}

function build(entries: Record<string, MemoryEntry>, senders: Record<string, MessageSender>) {
  const ports: BeliefGuardPorts = {
    getEntryById: async (id) => entries[id] ?? null,
    getMessageSender: async (id) => senders[id] ?? null,
  };
  const guard = new BeliefGuard(ports);

  const stored: MemoryEntry[] = [];
  const store: BeliefStore = {
    execute: async (input) => {
      stored.push({
        id: input.sourceId, layer: input.layer, contentType: input.contentType,
        sourceId: input.sourceId, sourceTable: input.sourceTable,
        conversationId: input.conversationId ?? null, granularity: input.granularity,
        content: input.content, metadata: input.metadata ?? null,
        createdAt: new Date().toISOString(),
      });
      return input.sourceId;
    },
  };
  return { record: new RecordBelief(guard, store), stored };
}

const partner = "user-42";

describe("F20261118belif: RecordBelief 写入路径", () => {
  it("合法 preference 入库：contentType=belief、status=recorded、metadata.kind=preference", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: "conv-A" });
    const { record, stored } = build({ m1 }, { m1: { senderType: "user", senderId: partner } });

    const { entryId } = await record.execute({
      kind: "preference", content: "搭档喜欢先看结论再看细节",
      anchors: ["m1"], conversationId: "conv-A", partnerUserId: partner,
    });

    expect(entryId).toBeTruthy();
    expect(stored).toHaveLength(1);
    const storedEntry = stored[0];
    expect(storedEntry.contentType).toBe("belief");
    expect(storedEntry.sourceTable).toBe("belief");
    expect(storedEntry.conversationId).toBe("conv-A");
    const meta = parseBeliefMetadata(storedEntry);
    expect(meta).not.toBeNull();
    expect(meta!.kind).toBe("preference");
    expect(meta!.status).toBe("recorded");
    expect(meta!.anchors).toEqual(["m1"]);
  });

  it("非法 preference（非搭档原话）拒收且不写入", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: "conv-A" });
    const { record, stored } = build({ m1 }, { m1: { senderType: "otter", senderId: "otter-x" } });

    await expect(record.execute({
      kind: "preference", content: "不该通过的喜好",
      anchors: ["m1"], conversationId: "conv-A", partnerUserId: partner,
    })).rejects.toThrow(/出处校验未通过/);
    expect(stored).toHaveLength(0);
  });

  it("合法 state（推断+依据）入库且 metadata 含 inferredFrom", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: "conv-A" });
    const m2 = makeEntry({ id: "m2", contentType: "message", conversationId: "conv-A" });
    const { record, stored } = build({ m1, m2 }, {});

    await record.execute({
      kind: "state", content: "当前共识是 X",
      anchors: ["m1"], inferredFrom: ["m2"], conversationId: "conv-A", partnerUserId: partner,
    });

    const meta = parseBeliefMetadata(stored[0]);
    expect(meta).not.toBeNull();
    expect(meta!.kind).toBe("state");
    expect(meta!.inferredFrom).toEqual(["m2"]);
  });
});