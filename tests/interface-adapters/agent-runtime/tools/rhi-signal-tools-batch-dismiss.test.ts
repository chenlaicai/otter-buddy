/** #1761：triage_signal batch_dismiss 工具分流与真 sqlite 状态验证。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SignalRepository } from "@usecases/health/signal-repository";
import { createTriageSignalTool } from "@interface-adapters/agent-runtime/tools/rhi-signal-tools";
import type { ToolContext } from "@usecases/ports/agent-tools";

const ctx = {
  otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-1", client: {},
} as unknown as ToolContext;

describe("triage_signal batch_dismiss（#1761）", () => {
  let db: Database.Database;
  let repo: SignalRepository;
  let tool: ReturnType<typeof createTriageSignalTool>;
  let seedSeq = 0;

  beforeEach(() => {
    db = createTestDb();
    repo = new SignalRepository(db);
    tool = createTriageSignalTool(ctx, repo);
  });
  afterEach(() => { db.close(); });

  const seedBound = (issueNumber: number) => {
    const record = repo.upsert({
      signalType: "guard_intercept", severity: "high", featureId: null,
      filePath: `src/tool-${seedSeq++}.ts`, evidence: "x", suggestedAction: null,
    });
    repo.triage(record.id, "bind_issue", { issueNumber });
    return record.id;
  };

  it("同一 issue 族一次收尾，返回数量并写入单条 dismiss 同款终态", async () => {
    const first = seedBound(1761);
    seedBound(1761);
    seedBound(9999);
    const response = await tool.execute("call-1", {
      action: "batch_dismiss", filterIssueNumber: 1761,
      note: "issue #1761 已修复，同族信号收尾",
    });
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0].text);
    expect(body).toMatchObject({ matched: 2, dismissed: 2, totalMatched: 2, truncated: false });
    expect(repo.findById(first)!.status).toBe("dismissed");
    expect(repo.findByTriageStatus("null").filter(row => row.status === "open")).toHaveLength(0);
    const other = repo.findOpen().find(row => row.issue_number === 9999);
    expect(other?.status).toBe("open");
  });

  it("支持预览，缺少有效范围或判断说明时拒绝", async () => {
    seedBound(1761);
    const preview = await tool.execute("call-1", {
      action: "batch_dismiss", filterIssueNumber: 1761, dryRun: true,
      note: "issue #1761 预览",
    });
    expect(preview.isError).toBeUndefined();
    expect(JSON.parse(preview.content[0].text)).toMatchObject({ matched: 1, dismissed: 0 });
    expect(repo.findOpen()).toHaveLength(1);

    for (const params of [
      { action: "batch_dismiss", filterIssueNumber: 1761 },
      { action: "batch_dismiss", filterSeverity: "high", note: "issue #1761 范围不足" },
    ]) {
      const response = await tool.execute("call-2", params);
      expect(response.isError).toBe(true);
    }
  });

  it("单条 dismiss 与 batch_bind 既有调用不受影响", async () => {
    const id = seedBound(1761);
    const single = await tool.execute("call-1", {
      action: "dismiss", signalId: id, note: "独立判断：误报，不处置",
    });
    expect(single.isError).toBeUndefined();
    expect(repo.findById(id)!.status).toBe("dismissed");
    repo.upsert({
      signalType: "other", severity: "low", featureId: null, filePath: "src/other.ts",
      evidence: "x", suggestedAction: null,
    });
    const bind = await tool.execute("call-2", {
      action: "batch_bind", filterSignalType: "other", issueNumber: 1761, note: "归口",
    });
    expect(bind.isError).toBeUndefined();
  });
});
