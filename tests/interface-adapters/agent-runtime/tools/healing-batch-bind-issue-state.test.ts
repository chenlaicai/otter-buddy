import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import { createManageHealingEventsTool } from "@interface-adapters/agent-runtime/tools/healing-tools";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { HealingEvent } from "@entities/healing/healing-event";

const ctx = {
  otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-1", client: {},
} as unknown as ToolContext;

function seedEvent(): HealingEvent {
  return {
    id: "he-1", messageId: "msg-1", conversationId: "conv-1", otterId: "otter-1",
    errorType: "guard_intercept", severity: "high", description: "待归口事件",
    suggestion: "", context: { ruleId: "r-1" }, status: "open", resolution: null,
    createdAt: new Date().toISOString(), resolvedAt: null,
  };
}

describe("manage_healing_events batch_bind 目标 issue 状态（#1786）", () => {
  let db: Database.Database;
  let repo: SqliteHealingEventRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteHealingEventRepository(db);
    await repo.create(seedEvent());
  });
  afterEach(() => { db.close(); });

  it.each([
    ["CLOSED", "目标 issue #42 状态为 CLOSED，仅可归口到 OPEN issue"],
    ["不存在", "无法核实目标 issue #42 状态：not found"],
    ["查询失败", "无法核实目标 issue #42 状态：network unavailable"],
  ])("%s 目标拒绝且事件不变", async (_case, reason) => {
    const tool = createManageHealingEventsTool(ctx, repo, async () => ({ ok: false, reason }));
    const result = await tool.execute("call-1", {
      action: "batch_bind", issueNumber: 42, filterErrorType: "guard_intercept", filterRuleId: "r-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(reason);
    expect(await repo.findById("he-1")).toMatchObject({ status: "open", boundIssue: null, boundAt: null });
  });

  it("OPEN 目标正常归口，dryRun 不查询外部状态也不写入", async () => {
    const check = vi.fn().mockResolvedValue({ ok: true as const });
    const tool = createManageHealingEventsTool(ctx, repo, check);

    const preview = await tool.execute("call-1", {
      action: "batch_bind", issueNumber: 42, filterErrorType: "guard_intercept", filterRuleId: "r-1", dryRun: true,
    });
    expect(preview.isError).toBeUndefined();
    expect(JSON.parse(preview.content[0]!.text)).toMatchObject({ dryRun: true, matched: 1 });
    expect(check).not.toHaveBeenCalled();
    expect((await repo.findById("he-1"))?.boundIssue ?? null).toBeNull();

    const bound = await tool.execute("call-2", {
      action: "batch_bind", issueNumber: 42, filterErrorType: "guard_intercept", filterRuleId: "r-1",
    });
    expect(bound.isError).toBeUndefined();
    expect(JSON.parse(bound.content[0]!.text)).toMatchObject({ bound: 1, issueNumber: 42 });
    expect(check).toHaveBeenCalledOnce();
    expect(await repo.findById("he-1")).toMatchObject({ status: "open", boundIssue: 42 });
  });
});
