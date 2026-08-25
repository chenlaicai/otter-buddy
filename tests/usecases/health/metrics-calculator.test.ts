import { describe, it, expect } from "vitest";
import { calculateMetrics } from "@usecases/health/metrics-calculator";
import { parseCommit } from "@usecases/health/commit-parser";

/** 构造测试数据：模拟一个微型仓库的 commit 历史 */
function buildSample() {
  const messages = [
    "[F20260824rhib][health][New Feature] RHI 面板 (#415)",
    "[F20260824axxx][agent][BugFix] 修复 agent 崩溃 (#416)",
    "[F20260824bxxx][agent][BugFix] 修复 agent 重启 (#417)",
    "[F20260824cxxx][memory][Feature Update] 优化检索 (#418)",
    "Merge branch 'feature/x' into main",
    "init: bootstrap",
  ];
  const filesPerCommit = [
    ["src/usecases/health/health-report.ts", "src/usecases/health/metrics-calculator.ts"],
    ["src/frameworks/agent/agent-invoker.ts", "web/src/pages/conversation/index.tsx"],
    ["src/frameworks/agent/agent-invoker.ts", "web/src/pages/conversation/index.tsx"],
    ["src/usecases/memory/search-memory.ts"],
    [], // merge commit 无文件列表
    [],
  ];

  const parsed = messages.map((m, i) => parseCommit(`sha${i}`, m));
  const commitsWithFiles = messages.map((m, i) => ({ sha: `sha${i}`, message: m, filesChanged: filesPerCommit[i] }));
  return { parsed, commitsWithFiles };
}

describe("calculateMetrics", () => {
  it("总览计数：total/withFid/compliant/skipped/bugfix", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles);

    expect(m.totalCommits).toBe(6);
    expect(m.commitsWithFid).toBe(4);       // 4 个带 FID
    expect(m.compliantCommits).toBe(4);     // 4 个严格三段
    expect(m.skippedCommits).toBe(2);       // merge + init
    expect(m.bugfixCount).toBe(2);
  });

  it("bugfix 比率双口径", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles);

    expect(m.bugfixRatio).toBeCloseTo(2 / 6);   // /totalCommits
    expect(m.bugfixRatioOfFid).toBeCloseTo(2 / 4); // /commitsWithFid
  });

  it("模块热区按 commit 数降序", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles);

    expect(m.moduleStats[0]).toEqual({ module: "agent", count: 2 });
    expect(m.moduleStats).toContainEqual({ module: "health", count: 1 });
    expect(m.moduleStats).toContainEqual({ module: "memory", count: 1 });
  });

  it("文件热点聚合与排序，merge commit 空文件列表不计数", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles);

    // agent-invoker.ts 与 conversation/index.tsx 各 2 次，并列第一
    const top2 = m.fileHotspots.slice(0, 2).map(h => h.count);
    expect(top2).toEqual([2, 2]);
    expect(m.fileHotspots).toContainEqual({ file: "src/frameworks/agent/agent-invoker.ts", count: 2 });
    expect(m.fileHotspots).toContainEqual({ file: "web/src/pages/conversation/index.tsx", count: 2 });
    expect(m.fileHotspots).toContainEqual({ file: "src/usecases/health/health-report.ts", count: 1 });
  });

  it("skipReason 分布显式可见", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles);

    expect(m.skipReasonDistribution).toEqual({
      merge_commit: 1,
      init_commit: 1,
    });
  });

  it("hotspotTopN 截断", () => {
    const { parsed, commitsWithFiles } = buildSample();
    const m = calculateMetrics(parsed, commitsWithFiles, { hotspotTopN: 1 });

    expect(m.fileHotspots).toHaveLength(1);
  });
});
