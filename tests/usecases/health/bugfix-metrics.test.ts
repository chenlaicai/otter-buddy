import { describe, it, expect } from "vitest";
import { computeFixInterval, buildFixIntervalRow } from "@usecases/health/bugfix-metrics";
import { parseCommit } from "@usecases/health/commit-parser";
import type { ParsedCommit } from "@usecases/health/commit-parser";

const NOW = new Date("2026-08-31T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** 构造一条 commit：changeType 由 message 段决定，date 独立传（与 parsed 按 index 对齐） */
function item(sha: string, message: string, date: Date): { parsed: ParsedCommit; date: Date } {
  return { parsed: parseCommit(sha, message), date };
}

function bugfix(sha: string, date: Date) {
  return item(sha, `[F20260824rhib][health][BugFix] 修 (#1)`, date);
}

function feature(sha: string, date: Date) {
  return item(sha, `[F20260824rhib][health][New Feature] 建 (#2)`, date);
}

function run(items: Array<{ parsed: ParsedCommit; date: Date }>, windowDays = 30) {
  return computeFixInterval(
    items.map(i => i.parsed),
    items.map(i => i.date),
    NOW,
    windowDays,
  );
}

describe("computeFixInterval（Issue #645 修复半衰期）", () => {
  it("窗口内 bugfix < 2 → intervalDays=null（无间隔可算，不伪造趋势）", () => {
    const r1 = run([]);
    expect(r1.intervalDays).toBeNull();
    expect(r1.metadata.intervalCount).toBe(0);
    expect(r1.metadata.bugfixCount).toBe(0);

    const r2 = run([bugfix("a", daysAgo(1))]);
    expect(r2.intervalDays).toBeNull();
    expect(r2.metadata.bugfixCount).toBe(1);
  });

  it("两个 bugfix → 单间隔即中位数", () => {
    const r = run([
      bugfix("a", daysAgo(3)),
      bugfix("b", daysAgo(1)),
    ]);
    expect(r.intervalDays).toBeCloseTo(2);
    expect(r.metadata).toEqual({ windowDays: 30, bugfixCount: 2, intervalCount: 1, stat: "median" });
  });

  it("非 bugfix commit 不参与（feature 混入不污染分子）", () => {
    const r = run([
      feature("f1", daysAgo(10)),
      bugfix("b1", daysAgo(3)),
      feature("f2", daysAgo(2)),
      bugfix("b2", daysAgo(1)),
    ]);
    // 只有 b1→b2 一个间隔 = 2 天（feature 不切段也不计入）
    expect(r.intervalDays).toBeCloseTo(2);
    expect(r.metadata.bugfixCount).toBe(2);
  });

  it("入参乱序不影响结果（内部按时间升序重排）", () => {
    const ordered = run([bugfix("a", daysAgo(3)), bugfix("b", daysAgo(1))]);
    const shuffled = run([bugfix("b", daysAgo(1)), bugfix("a", daysAgo(3))]);
    expect(shuffled.intervalDays).toBeCloseTo(ordered.intervalDays!);
  });

  it("奇数间隔取正中，偶数间隔取中间两数均值（标准中位数口径）", () => {
    // 奇数：4 commit → 3 间隔 [1,3,3] → 中位 3
    const odd = run([
      bugfix("a", daysAgo(9)),
      bugfix("b", daysAgo(8)),
      bugfix("c", daysAgo(5)),
      bugfix("d", daysAgo(2)),
    ]);
    expect(odd.intervalDays).toBeCloseTo(3);
    expect(odd.metadata.intervalCount).toBe(3);

    // 偶数：5 commit → 4 间隔 [1,3,5,14] → 中位 (3+5)/2=4
    const even = run([
      bugfix("a", daysAgo(16)),
      bugfix("b", daysAgo(15)),
      bugfix("c", daysAgo(12)),
      bugfix("d", daysAgo(7)),
      bugfix("e", daysAgo(2)),
    ]);
    expect(even.intervalDays).toBeCloseTo(4);
  });

  it("窗口外 bugfix 不参与（滚动窗口语义）", () => {
    const r = run([
      bugfix("old", daysAgo(31)), // 30 天窗口外
      bugfix("b1", daysAgo(3)),
      bugfix("b2", daysAgo(1)),
    ], 30);
    expect(r.intervalDays).toBeCloseTo(2);
    expect(r.metadata.bugfixCount).toBe(2);
  });

  it("窗口参数可调：windowDays=7 时 10 天前的 bugfix 出窗", () => {
    const items = [
      bugfix("a", daysAgo(10)),
      bugfix("b", daysAgo(3)),
      bugfix("c", daysAgo(1)),
    ];
    const wide = run(items, 30);
    expect(wide.metadata.bugfixCount).toBe(3);

    const narrow = run(items, 7);
    expect(narrow.metadata.bugfixCount).toBe(2);
    expect(narrow.metadata.windowDays).toBe(7);
    expect(narrow.intervalDays).toBeCloseTo(2);
  });
});

describe("buildFixIntervalRow", () => {
  it("落 fix_interval 行：metadata 带窗口参数（时间序列回放必读）", () => {
    const result = run([
      bugfix("a", daysAgo(3)),
      bugfix("b", daysAgo(1)),
    ]);
    const row = buildFixIntervalRow("2026-08-31", result);
    expect(row.snapshotDate).toBe("2026-08-31");
    expect(row.metricType).toBe("fix_interval");
    expect(row.metricKey).toBe("bugfix_median_interval_days");
    expect(row.metricValue).toBeCloseTo(2);
    const meta = JSON.parse(row.metadata);
    expect(meta).toEqual({ windowDays: 30, bugfixCount: 2, intervalCount: 1, stat: "median" });
  });

  it("null 时仍落行（metricValue=0 + intervalCount=0）：序列不断点，消费方可区分「算不出」与「间隔为 0」", () => {
    const row = buildFixIntervalRow("2026-08-31", run([]));
    expect(row.metricValue).toBe(0);
    const meta = JSON.parse(row.metadata);
    expect(meta.intervalCount).toBe(0);
  });
});
