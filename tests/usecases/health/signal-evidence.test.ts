import { describe, it, expect } from "vitest";
import { serializeRecurrenceCards } from "@usecases/health/signal-evidence";
import type { SignalRecord } from "@usecases/health/signal-repository";

/** Issue #647 项 1：复发模式卡序列化（频次从 commits.length 派生，非 occurrences） */

function rec(overrides: Partial<SignalRecord>): SignalRecord {
  return {
    id: 1,
    signal_type: "bug_recurrence",
    severity: "critical",
    feature_id: null,
    file_path: "src/a.ts",
    evidence: "e",
    first_seen: "2026-09-01T00:00:00Z",
    last_seen: "2026-09-01T00:00:00Z",
    occurrences: 42, // 故意夸张：若误用会立刻暴露
    status: "open",
    suggested_action: null,
    created_at: "2026-09-01T00:00:00Z",
    resolved_at: null,
    evidence_detail: null,
    confidence: null,
    ...overrides,
  };
}

const detail = {
  kind: "bug_recurrence_commits",
  windowDays: 30,
  commits: [
    { sha: "c3", date: "2026-08-25T00:00:00Z", changeType: "BugFix", message: "fix 2" },
    { sha: "c1", date: "2026-08-10T00:00:00Z", changeType: "BugFix", message: "fix 1" },
    { sha: "c2", date: "2026-08-18T00:00:00Z", changeType: "New Feature", message: "feat" },
  ],
};

describe("serializeRecurrenceCards（Issue #647 复发卡数据层）", () => {
  it("频次徽章 = commits.length 派生，与 occurrences 无关", () => {
    const cards = serializeRecurrenceCards([rec({ evidence_detail: JSON.stringify(detail) })], t => t);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.commitCount).toBe(3);
    expect(cards[0]!.commitCount).not.toBe(42);
  });

  it("时间轴序列按时间升序重排（存储顺序不可信）", () => {
    const cards = serializeRecurrenceCards([rec({ evidence_detail: JSON.stringify(detail) })], t => t);
    expect(cards[0]!.commits.map(c => c.sha)).toEqual(["c1", "c2", "c3"]);
  });

  it("重复 sha 去重（防窗口滑动残留致徽章虚高）", () => {
    const dup = { ...detail, commits: [...detail.commits, { ...detail.commits[0] }] };
    const cards = serializeRecurrenceCards([rec({ evidence_detail: JSON.stringify(dup) })], t => t);
    expect(cards[0]!.commitCount).toBe(3);
  });

  it("非 bug_recurrence / 无 detail / 坏 JSON / 错 kind 全部跳过", () => {
    const open = [
      rec({ id: 2, signal_type: "chain_stall", file_path: null }),
      rec({ id: 3, evidence_detail: null }),
      rec({ id: 4, evidence_detail: "{broken" }),
      rec({ id: 5, evidence_detail: JSON.stringify({ kind: "other" }) }),
    ];
    expect(serializeRecurrenceCards(open, t => t)).toHaveLength(0);
  });

  it("排序：频次优先，其次最近复发", () => {
    const more = { ...detail, commits: [...detail.commits, { sha: "c4", date: "2026-08-28T00:00:00Z", changeType: "BugFix", message: "x" }] };
    const open = [
      rec({ id: 10, file_path: "src/less.ts", last_seen: "2026-09-01T00:00:00Z", evidence_detail: JSON.stringify(detail) }),
      rec({ id: 11, file_path: "src/more.ts", last_seen: "2026-08-20T00:00:00Z", evidence_detail: JSON.stringify(more) }),
    ];
    const cards = serializeRecurrenceCards(open, t => t);
    expect(cards[0]!.filePath).toBe("src/more.ts"); // 4 次 > 3 次，频次优先
    expect(cards[0]!.windowDays).toBe(30);
  });
});
