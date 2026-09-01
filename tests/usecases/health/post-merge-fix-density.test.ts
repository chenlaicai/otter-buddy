import { describe, it, expect } from "vitest";
import { detectPostMergeFixDensity, computeFanInExclusions, FAN_IN_THRESHOLD, LARGE_CHAIN_FILES, RATIO_MIN_DENOMINATOR } from "@usecases/health/post-merge-fix-density";
import type { SignalCommitInput } from "@usecases/health/detect-signals";
import { parseCommit } from "@usecases/health/commit-parser";
import type { FeatureChain } from "@usecases/health/chain-builder";

const NOW = new Date("2026-09-01T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function commit(sha: string, dDaysAgo: number, message: string, files: string[]): SignalCommitInput {
  return { sha, date: daysAgo(dDaysAgo), message, parsed: parseCommit(sha, message), filesChanged: files };
}

function chain(featureId: string, files: string[], lastCommitDaysAgo: number): FeatureChain {
  return {
    featureId,
    state: "active",
    commits: [{ sha: "a0000000", date: new Date(daysAgo(lastCommitDaysAgo)), message: "merge", changeType: "New Feature", filesChanged: files, prNumber: 1 }],
    firstSeenAt: new Date(daysAgo(lastCommitDaysAgo)),
    lastCommitAt: new Date(daysAgo(lastCommitDaysAgo)),
    daysSinceLastCommit: lastCommitDaysAgo,
    commitCount: 1,
    bugfixCount: 0,
    touchFiles: new Set(files),
    doc: null,
  };
}

/** 小修链夹具：5 个文件（≤ LARGE_CHAIN_FILES=6 → 14 天窗口） */
function smallChain(featureId: string): FeatureChain {
  return chain(featureId, ["src/feat-a.ts", "src/feat-b.ts", "src/feat-c.ts", "src/feat-d.ts", "src/feat-e.ts"], 3);
}

/** 大特性链夹具：10 个文件（> 6 → 大特性档 30 天窗口） */
function largeChain(featureId: string): FeatureChain {
  return chain(featureId, Array.from({ length: 10 }, (_, i) => `src/big-${i}.ts`), 5);
}

describe("detectPostMergeFixDensity（Issue #647 项 6）", () => {
  it("恰好 3 次 bugfix 触发（≥ 阈值边界）", () => {
    const commits = [
      commit("b1", 2, "[F20260901xaaa][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 4, "[F20260901xaaa][agent][BugFix] 2", ["src/feat-b.ts"]),
      commit("b3", 6, "[F20260901xaaa][agent][BugFix] 3", ["src/feat-c.ts"]),
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901xaaa")], now: NOW });
    const sig = signals.find(s => s.featureId === "F20260901xaaa");
    expect(sig).toBeDefined();
    expect(sig!.type).toBe("post_merge_fix_density");
    expect(sig!.severity).toBe("warning"); // 「不对劲」是待查证不是定罪
    expect(sig!.evidence).toContain("3 次");
  });

  it("恰好占比 30% 触发（≥ 比率边界）：3 bugfix / 10 commit = 30%", () => {
    const commits: SignalCommitInput[] = [
      commit("f1", 2, "[F20260901xbbb][agent][New Feature] f1", ["src/other.ts"]),
      commit("f2", 2, "[F20260901xbbb][agent][New Feature] f2", ["src/other.ts"]),
      commit("f3", 2, "[F20260901xbbb][agent][New Feature] f3", ["src/other.ts"]),
    ];
    for (let i = 0; i < 3; i++) {
      commits.push(commit(`b${i}`, 3 + i, `[F20260901xbbb][agent][BugFix] ${i}`, ["src/feat-a.ts"]));
    }
    while (commits.length < 10) {
      commits.push(commit(`x${commits.length}`, 4, "[F20260901yaaa][agent][Feature Update] filler", ["src/zzz.ts"]));
    }
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901xbbb")], now: NOW });
    const sig = signals.find(s => s.featureId === "F20260901xbbb");
    expect(sig).toBeDefined();
    expect(sig!.evidence).toContain("3/10 = 30%");
  });

  it("纯占比支触发：2 bugfix / 5 commit = 40%（次数 <3 但占比 ≥30%，最小分母 5 达标）", () => {
    const commits: SignalCommitInput[] = [
      commit("b1", 2, "[F20260901xbbb][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 4, "[F20260901xbbb][agent][BugFix] 2", ["src/feat-b.ts"]),
      commit("f1", 2, "[F20260901xbbb][agent][Feature Update] f", ["src/other.ts"]),
      commit("f2", 2, "[F20260901xbbb][agent][Feature Update] f", ["src/other.ts"]),
      commit("f3", 2, "[F20260901xbbb][agent][Feature Update] f", ["src/other.ts"]),
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901xbbb")], now: NOW });
    expect(signals.find(s => s.featureId === "F20260901xbbb")).toBeDefined();
  });

  it("最小分母保护：窗口内 <5 条 commit 时占比支不启用（2 bugfix / 3 commit 不触发）", () => {
    const commits = [
      commit("b1", 2, "[F20260901yccc][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 3, "[F20260901yccc][agent][BugFix] 2", ["src/feat-a.ts"]),
      commit("f1", 3, "[F20260901yccc][agent][Feature Update] 填充分母", ["src/unrelated.ts"]),
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901yccc")], now: NOW });
    expect(signals.find(s => s.featureId === "F20260901yccc")).toBeUndefined();
  });

  it("窗口边界：小修档 14 天——第 15 天的 bugfix 不计入（2/7≈29% 且次数 2<3 → 不触发）", () => {
    const commits = [
      commit("b1", 2, "[F20260901zaaa][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 5, "[F20260901zaaa][agent][BugFix] 2", ["src/feat-b.ts"]),
      commit("b3", 15, "[F20260901zaaa][agent][BugFix] 3", ["src/feat-c.ts"]), // 小修档窗口外
      commit("f1", 3, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
      commit("f2", 4, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
      commit("f3", 6, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
      commit("f4", 7, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
      commit("f5", 8, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
      commit("f6", 9, "[F20260901zaaa][agent][Feature Update] f", ["src/unrelated.ts"]),
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901zaaa")], now: NOW });
    expect(signals.find(s => s.featureId === "F20260901zaaa")).toBeUndefined();
  });

  it("大特性档 30 天窗口：第 20 天的 bugfix 计入（小修档会漏）", () => {
    const commits = [
      commit("b1", 5, "[F20260901zaaa][agent][BugFix] 1", ["src/big-0.ts"]),
      commit("b2", 12, "[F20260901zaaa][agent][BugFix] 2", ["src/big-1.ts"]),
      commit("b3", 20, "[F20260901zaaa][agent][BugFix] 3", ["src/big-2.ts"]), // 只有大档（30天）才够得着
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [largeChain("F20260901zaaa")], now: NOW });
    const sig = signals.find(s => s.featureId === "F20260901zaaa");
    expect(sig).toBeDefined();
    expect(sig!.evidence).toContain("大特性档");
  });

  it("排除清单：高扇入文件不计入分子（≥10 特性触碰；FID 后缀纯字母）", () => {
    // 链触碰 big-0..4.ts（正常）+ hot.ts（将被排除）。bugfix 只碰 hot.ts → 排除后 0 次 → 不触发
    // FID 后缀合法形态：4-12 位纯字母（commit-parser 白名单 [2-9a-kmnp-z]，数字/短尾不合法）
    const letters = "abcdefghijkmnpqr";
    const fids = Array.from({ length: 10 }, (_, i) =>
      `F2026082${i < 5 ? 0 : 1}e${letters[i % 8]}${letters[(i + 3) % 8]}xy`);
    const commits: SignalCommitInput[] = [
      ...fids.map((fid, i) =>
        commit(`x${i}`, 3, `[${fid}][agent][Feature Update] 碰 hot`, ["hot.ts"])),
      commit("b1", 2, "[F20260901zaaa][agent][BugFix] 只碰枢纽", ["hot.ts"]),
      commit("b2", 4, "[F20260901zaaa][agent][BugFix] 只碰枢纽", ["hot.ts"]),
      commit("b3", 6, "[F20260901zaaa][agent][BugFix] 只碰枢纽", ["hot.ts"]),
    ];
    const ch = chain("F20260901zaaa", ["big-0.ts", "big-1.ts", "big-2.ts", "big-3.ts", "big-4.ts", "hot.ts"], 5);
    const { signals, excludedFiles } = detectPostMergeFixDensity({ commits, chains: [ch], now: NOW });
    expect(excludedFiles.some(x => x.file === "hot.ts" && x.fanIn >= 10)).toBe(true);
    expect(signals.find(s => s.featureId === "F20260901zaaa")).toBeUndefined();
  });

  it("排除清单命中时 evidence 透出清单摘要（可见不黑箱）", () => {
    const letters = "abcdefghijkmnpqr";
    const fids = Array.from({ length: 10 }, (_, i) =>
      `F2026082${i < 5 ? 0 : 1}e${letters[i % 8]}${letters[(i + 3) % 8]}xy`);
    const commits: SignalCommitInput[] = fids.map((fid, i) =>
      commit(`x${i}`, 3, `[${fid}][agent][Feature Update] 碰 hot`, ["hot.ts"]));
    commits.push(
      commit("b1", 2, "[F20260901zaaa][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 4, "[F20260901zaaa][agent][BugFix] 2", ["src/feat-b.ts"]),
      commit("b3", 6, "[F20260901zaaa][agent][BugFix] 3", ["src/feat-c.ts"]),
    );
    const { signals } = detectPostMergeFixDensity({ commits, chains: [smallChain("F20260901zaaa")], now: NOW });
    const sig = signals.find(s => s.featureId === "F20260901zaaa");
    expect(sig).toBeDefined();
    expect(sig!.evidence).toContain("排除高扇入文件");
    expect(sig!.evidence).toContain("hot.ts");
  });

  it("合入时刻早于窗口开启的特性不触发（非「合并后」范畴）", () => {
    const commits = [
      commit("b1", 2, "[F20260901zbbb][agent][BugFix] 1", ["src/feat-a.ts"]),
      commit("b2", 4, "[F20260901zbbb][agent][BugFix] 2", ["src/feat-b.ts"]),
      commit("b3", 6, "[F20260901zbbb][agent][BugFix] 3", ["src/feat-c.ts"]),
    ];
    // 链合于 20 天前（小修档 14 天窗口外）
    const old = chain("F20260901zbbb", ["src/feat-a.ts", "src/feat-b.ts", "src/feat-c.ts", "src/feat-d.ts", "src/feat-e.ts"], 20);
    const { signals } = detectPostMergeFixDensity({ commits, chains: [old], now: NOW });
    expect(signals.find(s => s.featureId === "F20260901zbbb")).toBeUndefined();
  });

  it("doc-only 链（无 commit）跳过", () => {
    const docOnly = chain("F20260901zccc", ["src/feat-a.ts"], 3);
    docOnly.commits = [];
    docOnly.lastCommitAt = null;
    const commits = [
      commit("b1", 2, "fix: 无 FID bugfix", ["src/feat-a.ts"]),
      commit("b2", 3, "fix: 无 FID bugfix", ["src/feat-b.ts"]),
      commit("b3", 4, "fix: 无 FID bugfix", ["src/feat-c.ts"]),
    ];
    const { signals } = detectPostMergeFixDensity({ commits, chains: [docOnly], now: NOW });
    expect(signals).toHaveLength(0);
  });

  it("分档与阈值常量符合实查依据（文档锚点：2026-09-01 实测 137 链）", () => {
    expect(LARGE_CHAIN_FILES).toBe(6);
    expect(FAN_IN_THRESHOLD).toBe(10);
    expect(RATIO_MIN_DENOMINATOR).toBe(5);
  });
});

describe("computeFanInExclusions（chains 端点常驻排除清单）", () => {
  it("扇入低于阈值不进清单", () => {
    const chains = [
      chain("F1", ["a.ts", "b.ts"], 1),
      chain("F2", ["a.ts"], 1),
      chain("F3", ["a.ts"], 1),
    ];
    const list = computeFanInExclusions(chains);
    expect(list.find(x => x.file === "a.ts")).toBeUndefined();
  });

  it("扇入达阈值进清单", () => {
    const chains = Array.from({ length: 10 }, (_, i) => chain(`F${i}`, ["hub.ts"], 1));
    const list = computeFanInExclusions(chains);
    expect(list).toEqual([{ file: "hub.ts", fanIn: 10 }]);
  });
});
