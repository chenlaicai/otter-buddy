/**
 * F20261118belif P1a：belief-guard 四维出处校验 + 状态机 + 防环 单元测试。
 */
import { describe, it, expect } from "vitest";
import { BeliefGuard, isLegalBeliefTransition } from "@usecases/memory/belief-guard";
import type { BeliefGuardPorts, MessageSender } from "@usecases/memory/belief-guard";
import type { MemoryEntry } from "@entities/memory/memory-entry";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-default",
    layer: "working",
    contentType: "message",
    sourceId: "src-1",
    sourceTable: "entries",
    conversationId: "conv-A",
    granularity: "fine",
    content: "测试内容",
    metadata: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function makeGuard(entries: Record<string, MemoryEntry>, senders: Record<string, MessageSender>) {
  const ports: BeliefGuardPorts = {
    getEntryById: async (id) => entries[id] ?? null,
    getMessageSender: async (id) => senders[id] ?? null,
  };
  return new BeliefGuard(ports);
}

const partner = "user-42";
const conv = "conv-A";

describe("F20261118belif: belief 状态机迁移矩阵", () => {
  it("合法迁移全覆盖", () => {
    expect(isLegalBeliefTransition("recorded", "verified")).toBe(true);
    expect(isLegalBeliefTransition("recorded", "disputed")).toBe(true);
    expect(isLegalBeliefTransition("recorded", "superseded")).toBe(true);
    expect(isLegalBeliefTransition("verified", "disputed")).toBe(true);
    expect(isLegalBeliefTransition("verified", "superseded")).toBe(true);
    expect(isLegalBeliefTransition("disputed", "recorded")).toBe(true);
    expect(isLegalBeliefTransition("disputed", "superseded")).toBe(true);
  });

  it("非法迁移被拒（含终态出边）", () => {
    expect(isLegalBeliefTransition("superseded", "verified")).toBe(false);
    expect(isLegalBeliefTransition("recorded", "recorded")).toBe(false);
    expect(isLegalBeliefTransition("verified", "recorded")).toBe(false);
    expect(isLegalBeliefTransition("verified", "verified")).toBe(false);
    expect(isLegalBeliefTransition("disputed", "verified")).toBe(false);
  });
});

describe("F20261118belif: belief-guard 四维出处校验", () => {
  it("新条目 status 非 recorded 拒收", async () => {
    const guard = makeGuard({}, {});
    const r = await guard.validate({
      kind: "state", status: "verified", content: "测试内容", anchors: ["m1"], conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "transition")).toBe(true);
  });

  it("preference 锚点不存在拒收（anchor_existence）", async () => {
    const guard = makeGuard({}, {});
    const r = await guard.validate({
      kind: "preference", status: "recorded", content: "测试内容", anchors: ["ghost"], conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "anchor_existence")).toBe(true);
  });

  it("空 anchors 拒收（空出处 = 拒收，v4 硬约束 2）", async () => {
    const guard = makeGuard({}, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: [], inferredFrom: ["m1"],
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "anchor_existence")).toBe(true);
  });

  it("belief 内容超长拒收（content_length）", async () => {
    const guard = makeGuard({}, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "长".repeat(501), anchors: ["m1"], inferredFrom: ["m1"],
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "content_length")).toBe(true);
  });

  it("preference 锚点非 user 拒收（anchor_identity）", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, { m1: { senderType: "otter", senderId: "otter-x" } });
    const r = await guard.validate({
      kind: "preference", status: "recorded", content: "测试内容", anchors: ["m1"], conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "anchor_identity")).toBe(true);
  });

  it("preference 锚点 senderId 非本对话搭档拒收（anchor_identity）", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, { m1: { senderType: "user", senderId: "another-user" } });
    const r = await guard.validate({
      kind: "preference", status: "recorded", content: "测试内容", anchors: ["m1"], conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "anchor_identity")).toBe(true);
  });

  it("preference 搭档原话锚点合法通过", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, { m1: { senderType: "user", senderId: partner } });
    const r = await guard.validate({
      kind: "preference", status: "recorded", content: "测试内容", anchors: ["m1"], conversationId: conv, partnerUserId: partner,
    });
    expect(r).toEqual({ ok: true });
  });

  it("state 无推断依据拒收（inference_basis）", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "inference_basis")).toBe(true);
  });

  it("state 推断依据条目不存在拒收", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["ghost-basis"],
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "inference_basis")).toBe(true);
  });

  it("state 合法（消息锚点 + 推断依据存在）通过", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const m2 = makeEntry({ id: "m2", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1, m2 }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m2"],
      conversationId: conv, partnerUserId: partner,
    });
    expect(r).toEqual({ ok: true });
  });

  it("state 锚点 message 属于其他对话拒收（anchor_scope）", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: "other-conv" });
    const m2 = makeEntry({ id: "m2", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1, m2 }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m2"],
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "anchor_scope")).toBe(true);
  });
});

describe("F20261118belif: belief-guard 防环", () => {
  it("supersedes 目标不存在拒收", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const guard = makeGuard({ m1 }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m1"], supersedes: "ghost-belief",
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "cycle")).toBe(true);
  });

  it("supersedes 目标不是 belief 拒收", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const notBelief = makeEntry({ id: "n1", contentType: "fact" });
    const guard = makeGuard({ m1, n1: notBelief }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m1"], supersedes: "n1",
      conversationId: conv, partnerUserId: partner,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "cycle")).toBe(true);
  });

  it("supersedes 目标 createdAt 晚于源拒收（A↔B 互替环拦截）", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const futureBelief = makeEntry({
      id: "b-future", contentType: "belief", createdAt: "2027-01-01T00:00:00Z",
      metadata: { kind: "state", status: "recorded", anchors: ["m1"] },
    });
    const guard = makeGuard({ m1, "b-future": futureBelief }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m1"], supersedes: "b-future",
      conversationId: conv, partnerUserId: partner, nowMs: Date.parse("2026-11-18T00:00:00Z"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.dimension === "cycle")).toBe(true);
  });

  it("supersedes 目标合法（旧 belief，createdAt 早于源）通过", async () => {
    const m1 = makeEntry({ id: "m1", contentType: "message", conversationId: conv });
    const oldBelief = makeEntry({
      id: "b-old", contentType: "belief", createdAt: "2026-10-01T00:00:00Z",
      metadata: { kind: "state", status: "verified", anchors: ["m1"] },
    });
    const guard = makeGuard({ m1, "b-old": oldBelief }, {});
    const r = await guard.validate({
      kind: "state", status: "recorded", content: "测试内容", anchors: ["m1"], inferredFrom: ["m1"], supersedes: "b-old",
      conversationId: conv, partnerUserId: partner, nowMs: Date.parse("2026-11-18T00:00:00Z"),
    });
    expect(r).toEqual({ ok: true });
  });
});