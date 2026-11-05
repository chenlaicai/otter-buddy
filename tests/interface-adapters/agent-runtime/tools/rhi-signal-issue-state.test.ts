import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { createTriageSignalTool } from "@interface-adapters/agent-runtime/tools/rhi-signal-tools";
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
