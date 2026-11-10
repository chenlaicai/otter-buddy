import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { createTriageSignalTool, createListRhiSignalsTool } from "@interface-adapters/agent-runtime/tools/rhi-signal-tools";
import { SignalRepository } from "@usecases/health/signal-repository";
import type { ToolContext } from "@usecases/ports/agent-tools";

const ctx = {
  otterId: "otter-1",
  conversationId: "conv-1",
  currentMessageId: "msg-1",
  client: {},
} as unknown as ToolContext;

const allowBinding = async () => ({ ok: true as const });
const rejectClosed = async () => ({
  ok: false as const,
  reason: "目标 issue #1319 状态为 CLOSED，仅可归口到 OPEN issue",
});

describe("triage_signal 目标 issue 状态", () => {
  let db: Database.Database;
  let repo: SignalRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SignalRepository(db);
  });
  afterEach(() => { db.close(); });

  function seed() {
    return repo.upsert({
      signalType: "bug_recurrence",
      severity: "critical",
      featureId: null,
      filePath: "src/invoker.ts",
      evidence: "content_filter 后重复出现",
      suggestedAction: null,
    });
  }

  it("bind_issue 对 CLOSED 目标报错且不改变原信号", async () => {
    const signal = seed();
    const tool = createTriageSignalTool(ctx, repo, rejectClosed);

    const result = await tool.execute("call-1", {
      action: "bind_issue", signalId: signal.id, issueNumber: 1319,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("CLOSED");
    expect(repo.findById(signal.id)).toMatchObject({
      status: "open", triage_status: null, issue_number: null, triaged_at: null,
    });
  });

  it("batch_bind 对 CLOSED 目标报错且不写入任何匹配行", async () => {
    const first = seed();
    const second = repo.upsert({
      signalType: "bug_recurrence",
      severity: "critical",
      featureId: null,
      filePath: "src/other.ts",
      evidence: "另一条同族信号",
      suggestedAction: null,
    });
    const tool = createTriageSignalTool(ctx, repo, rejectClosed);

    const result = await tool.execute("call-1", {
      action: "batch_bind", issueNumber: 1319, filterSignalType: "bug_recurrence",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("CLOSED");
    for (const id of [first.id, second.id]) {
      expect(repo.findById(id)).toMatchObject({ triage_status: null, issue_number: null });
    }
  });

  it("OPEN 目标仍沿用既有单条与批量归口行为", async () => {
    const signal = seed();
    const tool = createTriageSignalTool(ctx, repo, allowBinding);

    const single = await tool.execute("call-1", {
      action: "bind_issue", signalId: signal.id, issueNumber: 1760,
    });
    expect(single.isError).toBeUndefined();
    expect(repo.findById(signal.id)!.issue_number).toBe(1760);

    const other = repo.upsert({
      signalType: "bug_recurrence",
      severity: "critical",
      featureId: null,
      filePath: "src/other.ts",
      evidence: "另一条同族信号",
      suggestedAction: null,
    });
    const batch = await tool.execute("call-2", {
      action: "batch_bind", issueNumber: 1760, filterSignalType: "bug_recurrence",
    });
    expect(batch.isError).toBeUndefined();
    expect(repo.findById(other.id)!.issue_number).toBe(1760);
  });
});

describe("list_rhi_signals 关单遗留只读提醒（#1787）", () => {
  let db: Database.Database;
  let repo: SignalRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SignalRepository(db);
  });
  afterEach(() => { db.close(); });

  function seedBound(issueNumber: number, filePath: string) {
    const signal = repo.upsert({
      signalType: "bug_recurrence",
      severity: "warning",
      featureId: null,
      filePath,
      evidence: `绑定 issue #${issueNumber}`,
      suggestedAction: null,
    });
    const bound = repo.triage(signal.id, "bind_issue", { issueNumber });
    expect(bound.ok).toBe(true);
    return signal;
  }

  it("只列明确 CLOSED 的数量与 ID，同 issue 去重查询且 sqlite 零写入", async () => {
    const closedA = seedBound(1319, "src/closed-a.ts");
    const closedB = seedBound(1319, "src/closed-b.ts");
    const open = seedBound(1760, "src/open.ts");
    const unknown = seedBound(1999, "src/unknown.ts");
    const before = JSON.stringify(repo.findOpen());
    const calls: number[] = [];
    const readState = async (issueNumber: number) => {
      calls.push(issueNumber);
      if (issueNumber === 1319) return { ok: true as const, state: "CLOSED" };
      if (issueNumber === 1760) return { ok: true as const, state: "OPEN" };
      return { ok: false as const, reason: "gh unavailable" };
    };
    const tool = createListRhiSignalsTool(ctx, repo, readState);

    const result = await tool.execute("call-list", { status: "open", triageStatus: "triaged", closedIssueOnly: true });
    const text = result.content[0]!.text;
    expect(text).toContain("关单遗留 RHI 信号（2 条）");
    expect(text).toContain(`[#${closedA.id}]`);
    expect(text).toContain(`[#${closedB.id}]`);
    expect(text).toContain("#1319");
    expect(text).toContain("转绑");
    expect(text).not.toContain(`[#${open.id}]`);
    expect(text).not.toContain(`[#${unknown.id}]`);
    expect(text).toContain("#1999");
    expect(text).toContain("状态查询失败");
    expect(calls.sort((a, b) => a - b)).toEqual([1319, 1760, 1999]);
    expect(calls.filter(issue => issue === 1319)).toHaveLength(1);
    expect(JSON.stringify(repo.findOpen())).toBe(before);
  });

  it("无关单遗留时只报一行 0", async () => {
    seedBound(1760, "src/open.ts");
    const tool = createListRhiSignalsTool(ctx, repo, async () => ({ ok: true as const, state: "OPEN" }));
    const result = await tool.execute("call-list", { status: "open", triageStatus: "triaged", closedIssueOnly: true });
    expect(result.content[0]!.text).toBe("关单遗留 RHI 信号：0");
  });

  it("默认清单不查询 GitHub 且保持原输出形态", async () => {
    const signal = seedBound(1760, "src/open.ts");
    let called = false;
    const tool = createListRhiSignalsTool(ctx, repo, async () => {
      called = true;
      return { ok: true as const, state: "CLOSED" };
    });
    const result = await tool.execute("call-list", { status: "open", triageStatus: "triaged" });
    expect(called).toBe(false);
    expect(result.content[0]!.text).toContain(`[#${signal.id}]`);
    expect(result.content[0]!.text).toContain("RHI 信号（1 条）");
    expect(result.content[0]!.text).not.toContain("关单遗留");
  });
});
