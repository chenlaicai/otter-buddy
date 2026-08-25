import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import type { HealingEvent, HealingResolution } from "@entities/healing/healing-event";

function seedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: `he-${Math.random().toString(36).slice(2, 8)}`,
    messageId: "msg-1", conversationId: "conv-1", otterId: "otter-1",
    errorType: "tool_failure", severity: "low", description: "test event",
    suggestion: "", context: null, status: "open", resolution: null,
    createdAt: new Date().toISOString(), resolvedAt: null,
    ...overrides,
  };
}

const defaultResolution: HealingResolution = {
  action: "no_action", decidedBy: "agent",
  decidedAt: new Date().toISOString(), notes: "batch test",
};

describe("SqliteHealingEventRepository.batchResolveByFilter", () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteHealingEventRepository(db); });
  afterEach(() => { db.close(); });

  it("dryRun 只返回匹配数，不执行 resolve", async () => {
    await repo.create(seedEvent({ errorType: "tool_failure" }));
    await repo.create(seedEvent({ errorType: "missing_context" }));
    await repo.create(seedEvent({ status: "resolved" }));
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution, { dryRun: true });
    expect(result.matched).toBe(2);
    expect(result.resolved).toBe(0);
    expect(result.resolvedIds).toEqual([]);
    const openEvents = await repo.findAll("open");
    expect(openEvents).toHaveLength(2);
  });

  it("批量 resolve 所有 open 事件", async () => {
    await repo.create(seedEvent({ id: "evt-1" }));
    await repo.create(seedEvent({ id: "evt-2" }));
    await repo.create(seedEvent({ id: "evt-3", status: "resolved" }));
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution);
    expect(result.matched).toBe(2);
    expect(result.resolved).toBe(2);
    expect(result.resolvedIds).toHaveLength(2);
    const openEvents = await repo.findAll("open");
    expect(openEvents).toHaveLength(0);
  });

  it("按 errorType 过滤", async () => {
    await repo.create(seedEvent({ id: "evt-1", errorType: "tool_failure" }));
    await repo.create(seedEvent({ id: "evt-2", errorType: "missing_context" }));
    await repo.create(seedEvent({ id: "evt-3", errorType: "tool_failure" }));
    const result = await repo.batchResolveByFilter({ status: "open", errorType: "tool_failure" }, defaultResolution);
    expect(result.matched).toBe(2);
    expect(result.resolved).toBe(2);
    expect(result.resolvedIds).toContain("evt-1");
    expect(result.resolvedIds).toContain("evt-3");
  });

  it("按 createdBefore 过滤", async () => {
    await repo.create(seedEvent({ id: "evt-old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await repo.create(seedEvent({ id: "evt-new", createdAt: "2026-08-25T00:00:00.000Z" }));
    const result = await repo.batchResolveByFilter({ status: "open", createdBefore: "2026-06-01T00:00:00.000Z" }, defaultResolution);
    expect(result.matched).toBe(1);
    expect(result.resolvedIds).toEqual(["evt-old"]);
  });

  it("按 createdAfter 过滤", async () => {
    await repo.create(seedEvent({ id: "evt-old", createdAt: "2026-01-01T00:00:00.000Z" }));
    await repo.create(seedEvent({ id: "evt-new", createdAt: "2026-08-25T00:00:00.000Z" }));
    const result = await repo.batchResolveByFilter({ status: "open", createdAfter: "2026-06-01T00:00:00.000Z" }, defaultResolution);
    expect(result.matched).toBe(1);
    expect(result.resolvedIds).toEqual(["evt-new"]);
  });

  it("组合 filter: errorType + createdBefore", async () => {
    await repo.create(seedEvent({ id: "evt-1", errorType: "tool_failure", createdAt: "2026-01-01T00:00:00.000Z" }));
    await repo.create(seedEvent({ id: "evt-2", errorType: "tool_failure", createdAt: "2026-08-25T00:00:00.000Z" }));
    await repo.create(seedEvent({ id: "evt-3", errorType: "missing_context", createdAt: "2026-01-01T00:00:00.000Z" }));
    const result = await repo.batchResolveByFilter({ status: "open", errorType: "tool_failure", createdBefore: "2026-06-01T00:00:00.000Z" }, defaultResolution);
    expect(result.matched).toBe(1);
    expect(result.resolvedIds).toEqual(["evt-1"]);
  });

  it("空结果返回 matched=0", async () => {
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution);
    expect(result.matched).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.resolvedIds).toEqual([]);
  });

  it("limit 上限生效 + truncated 标志", async () => {
    for (let i = 0; i < 5; i++) await repo.create(seedEvent({ id: `evt-${i}` }));
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution, { limit: 3 });
    expect(result.matched).toBe(3);
    expect(result.resolved).toBe(3);
    expect(result.totalMatched).toBe(5);
    expect(result.truncated).toBe(true);
    const remaining = await repo.findAll("open");
    expect(remaining).toHaveLength(2);
  });

  it("未截断时 truncated=false", async () => {
    await repo.create(seedEvent({ id: "evt-1" }));
    await repo.create(seedEvent({ id: "evt-2" }));
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution, { limit: 100 });
    expect(result.matched).toBe(2);
    expect(result.totalMatched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("resolve 记录包含正确的 resolution 数据", async () => {
    await repo.create(seedEvent({ id: "evt-1" }));
    const resolution: HealingResolution = { action: "tool_fixed", decidedBy: "agent", decidedAt: "2026-08-25T10:00:00.000Z", notes: "修复了工具故障" };
    await repo.batchResolveByFilter({ status: "open" }, resolution);
    const event = await repo.findById("evt-1");
    expect(event?.status).toBe("resolved");
    expect(event?.resolution?.action).toBe("tool_fixed");
    expect(event?.resolution?.notes).toBe("修复了工具故障");
    expect(event?.resolvedAt).toBeTruthy();
  });

  it("已 resolved 的事件不会被重复处理", async () => {
    await repo.create(seedEvent({ id: "evt-1", status: "resolved" }));
    await repo.create(seedEvent({ id: "evt-2", status: "open" }));
    const result = await repo.batchResolveByFilter({ status: "open" }, defaultResolution);
    expect(result.matched).toBe(1);
    expect(result.resolvedIds).toEqual(["evt-2"]);
  });
});
