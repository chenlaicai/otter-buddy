/**
 * F20261019f714（M-f7148deb 第 1 条）：create() INSERT 缺 bound_issue/bound_at 列修复。
 *
 * 修复前缺陷：create() 的 INSERT 列清单不含归口两列——调用方/种子数据直接给
 * boundIssue/boundAt 会被**静默丢弃**（库内落 NULL）。此前测试用直插 SQL 绕过
 * （隐性契约）。修复后：全字段 round-trip，任何写入路径不静默丢数据。
 *
 * 「修复前失败」证据链：本文件 it("create() 带 boundIssue/boundAt 写入 → findById
 * round-trip 读回同值") 在修复前（INSERT 缺两列）必红——boundIssue 读回 null ≠ 1361。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";

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

describe("F20261019f714 create() 全字段 round-trip（含归口两列）", () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteHealingEventRepository(db); });
  afterEach(() => { db.close(); });

  it("create() 带 boundIssue/boundAt 写入 → findById round-trip 读回同值（修复前：静默丢成 null）", async () => {
    const ev = seedEvent({ boundIssue: 1361, boundAt: "2026-10-19T03:00:00.000Z" });
    await repo.create(ev);
    const back = await repo.findById(ev.id);
    expect(back).not.toBeNull();
    expect(back!.boundIssue).toBe(1361);
    expect(back!.boundAt).toBe("2026-10-19T03:00:00.000Z");
  });

  it("create() 不带归口字段 → 落 NULL（默认行为不变）", async () => {
    const ev = seedEvent();
    await repo.create(ev);
    const back = await repo.findById(ev.id);
    expect(back!.boundIssue).toBeNull();
    expect(back!.boundAt).toBeNull();
  });

  it("裸 SQL 对照：同值直插可读回（锚定 mapper 读侧本就支持，缺陷只在 create() 写侧）", async () => {
    const ev = seedEvent();
    db.prepare(
      "INSERT INTO healing_events (id, message_id, conversation_id, otter_id, error_type, severity, description, suggestion, context, status, resolution, created_at, resolved_at, introduced_by_pr, bound_issue, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ev.id, ev.messageId, ev.conversationId, ev.otterId, ev.errorType, ev.severity, ev.description, ev.suggestion, null, ev.status, null, ev.createdAt, null, null, 1550, "2026-10-19T04:59:00.000Z");
    const back = await repo.findById(ev.id);
    expect(back!.boundIssue).toBe(1550);
    expect(back!.boundAt).toBe("2026-10-19T04:59:00.000Z");
  });
});
