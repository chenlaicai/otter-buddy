import { describe, it, expect } from "vitest";
import { buildOverviewSnapshotRows } from "@usecases/health/snapshot-rows";
import type { Metrics } from "@usecases/health/metrics-calculator";

/** F20260829hviz：snapshot-rows 共享模块单元测试。
 *  口径锁定：11 标准行 + extraRows 追加；HealthReport 与 RhiScanWorker 两条写入路径同构。 */

function fakeMetrics(): Metrics {
  return {
    totalCommits: 100,
    commitsWithFid: 90,
    compliantCommits: 85,
    skippedCommits: 5,
    bugfixCount: 27,
    bugfixRatio: 0.27,
    bugfixRatioOfFid: 0.3,
    changeTypeDistribution: { Feature: 50, BugFix: 27 },
    skipReasonDistribution: { merge: 5 },
    moduleStats: [
      { module: "agent", count: 40 },
      { module: "web", count: 20 },
    ],
    fileHotspots: [
      { file: "src/x.ts", count: 19 },
    ],
  };
}

describe("buildOverviewSnapshotRows", () => {
  it("标准 11 行：7 overview + 4 distribution", () => {
    const rows = buildOverviewSnapshotRows({ snapshotDate: "2026-08-28", metrics: fakeMetrics() });
    expect(rows).toHaveLength(11);

    const overview = rows.filter(r => r.metricType === "overview");
    const distribution = rows.filter(r => r.metricType === "distribution");
    expect(overview).toHaveLength(7);
    expect(distribution.map(r => r.metricKey)).toEqual([
      "change_types", "skip_reasons", "modules", "file_hotspots",
    ]);
  });

  it("所有行携带 snapshotDate（sink 侧 replaceForDate 依赖行内日期一致性）", () => {
    const rows = buildOverviewSnapshotRows({ snapshotDate: "2026-08-01", metrics: fakeMetrics() });
    for (const r of rows) expect(r.snapshotDate).toBe("2026-08-01");
  });

  it("distribution metadata 是合法 JSON", () => {
    const rows = buildOverviewSnapshotRows({ snapshotDate: "2026-08-28", metrics: fakeMetrics() });
    for (const r of rows.filter(x => x.metricType === "distribution")) {
      expect(() => JSON.parse(r.metadata!)).not.toThrow();
    }
  });

  it("extraRows 追加在标准行之后（worker 的 chain_states 场景）", () => {
    const rows = buildOverviewSnapshotRows({
      snapshotDate: "2026-08-28",
      metrics: fakeMetrics(),
      extraRows: [{
        snapshotDate: "2026-08-28",
        metricType: "distribution",
        metricKey: "chain_states",
        metricValue: 5,
        metadata: JSON.stringify({ active: 3, stalled: 2 }),
      }],
    });
    expect(rows).toHaveLength(12);
    expect(rows[11]!.metricKey).toBe("chain_states");
    expect(JSON.parse(rows[11]!.metadata!)).toEqual({ active: 3, stalled: 2 });
  });
});
