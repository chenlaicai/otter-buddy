import { describe, it, expect } from "vitest";
import { detectPostMergeFixDensity, windowDaysForChain } from "@usecases/health/post-merge-fix-density";
import { detectSignals } from "@usecases/health/detect-signals";
import { parseCommit } from "@usecases/health/commit-parser";
import { buildFeatureChains } from "@usecases/health/chain-builder";
import type { SignalCommitInput } from "@usecases/health/detect-signals";

const NOW = new Date("2026-09-01T12:00:00+08:00");

function dayAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function commit(sha: string, daysAgo: number, message: string, files: string[]): SignalCommitInput {
  return { sha, date: dayAgo(daysAgo), message, parsed: parseCommit(sha, message), filesChanged: files };
}

function docOf(id: string, createdAtDaysAgo: number) {
  return {
    id, title: `t-${id}`, changeType: "feature", status: "shipped",
    tags: [], modules: [], causalLinksFrom: [], supersedes: [],
    filePath: `docs/features/x/${id}.md`, createdAt: dayAgo(createdAtDaysAgo), createdInConversationId: null,
  };
}

describe("post_merge_fix_density（Issue #647 合并后修复密度）", () => {
  it("窗口分档：小链 14 / 中链 21 / 大链 30 天", () => {
    expect(windowDaysForChain(5)).toBe(14);
    expect(windowDaysForChain(10)).toBe(14);
    expect(windowDaysForChain(11)).toBe(21);
    expect(windowDaysForChain(30)).toBe(21);
    expect(windowDaysForChain(31)).toBe(30);
  });

  it("合入后 3 次 bugfix（触碰链文件）触发，evidence 带窗口与占比", () => {
    // 链 X：3 commit，合入 20 天前；14 天窗口 = (20d前, 6d前]
    const chains = buildFeatureChains([
      commit("x1", 30, "[F20260801xxaa][agent][New Feature] 引入", ["src/x.ts"]),
      commit("x2", 25, "[F20260801xxaa][agent][Feature Update] 迭代", ["src/x.ts"]),
      commit("x3", 20, "[F20260801xxaa][agent][Feature Update] 收尾", ["src/x.ts"]),
    ], [docOf("F20260801xxaa", 30)], { now: NOW });
    // 合入后修复：另一特性的 bugfix 触碰 src/x.ts ×3（窗口内）
    const commits = [
      commit("f1", 10, "[F20260801fixz][agent][BugFix] 修 1 (#31)", ["src/x.ts"]),
      commit("f2", 8, "[F20260801fixz][agent][BugFix] 修 2 (#32)", ["src/x.ts"]),
      commit("f3", 6, "[F20260801fixz][agent][BugFix] 修 3 (#33)", ["src/x.ts"]),
    ];

    const signals = detectPostMergeFixDensity(commits, chains, { now: NOW });
    const sig = signals.find(s => s.featureId === "F20260801xxaa");
    expect(sig).toBeDefined();
    expect(sig!.severity).toBe("warning");
    expect(sig!.evidence).toContain("bugfix 3 次");
    expect(sig!.detail!.kind).toBe("post_merge_fix_density");
    const d = sig!.detail!;
    if (d.kind === "post_merge_fix_density") {
      expect(d.windowDays).toBe(14);
      expect(d.fixCommits).toHaveLength(3);
      expect(d.totalRelatedCommits).toBe(3);
      expect(d.fixRatio).toBe(1);
      expect(d.excludedHighFaninFiles).toEqual([]);
    }
  });

  it("占比 ≥30% 触发（次数 <3 但占比高）", () => {
    // 链 Y：合入 35 天前；14 天窗口 = (35d前, 21d前]，窗口内 commit 都放这段
    const chains = buildFeatureChains([
      commit("y1", 40, "[F20260801yyaa][agent][New Feature] 引入", ["src/y.ts"]),
      commit("y2", 35, "[F20260801yyaa][agent][Feature Update] 收尾", ["src/y.ts"]),
    ], [docOf("F20260801yyaa", 40)], { now: NOW });
    const commits = [
      commit("f1", 30, "[F20260801fixz][agent][BugFix] 修 (#41)", ["src/y.ts"]),
      commit("f2", 28, "[F20260801fixz][agent][BugFix] 修 (#42)", ["src/y.ts"]),
      commit("o1", 25, "[F20260801othh][agent][Feature Update] 无关迭代 (#43)", ["src/y.ts"]),
      commit("o2", 24, "[F20260801othh][agent][New Feature] 无关功能 (#44)", ["src/y.ts"]),
      commit("o3", 23, "[F20260801othh][agent][Refactor] 无关重构 (#45)", ["src/y.ts"]),
    ];
    // 2/5 = 40% ≥30% → 触发；2 <3 次数线不足——锁「占比分支」
    const signals = detectPostMergeFixDensity(commits, chains, { now: NOW });
    const sig = signals.find(s => s.featureId === "F20260801yyaa");
    expect(sig).toBeDefined();
    expect(sig!.evidence).toContain("占比 40%");
  });

  it("高扇入文件排除：被 ≥5 特性链触碰的文件不参与链级计数（反证：不排除则触发）", () => {
    // app.ts 被 5 条链触碰（合入 35..31 天前，窗口互有重叠段 (31,21]）
    const chainCommits = ["a", "b", "c", "d", "e"].flatMap((ch, i) => [
      commit(`${ch}1`, 40 - i, `[F20260801${ch}${ch}aa][agent][New Feature] 引入`, ["src/app.ts"]),
      commit(`${ch}2`, 35 - i, `[F20260801${ch}${ch}aa][agent][Feature Update] 收尾`, ["src/app.ts"]),
    ]);
    const docs = ["a", "b", "c", "d", "e"].map((ch, i) => docOf(`F20260801${ch}${ch}aa`, 40 - i));
    const chains = buildFeatureChains(chainCommits, docs, { now: NOW });

    // 3 次 bugfix 全部触碰 app.ts（落在所有链的窗口重叠段）
    const fixes = [
      commit("fz1", 25, "[F20260801fixz][agent][BugFix] 修 1 (#51)", ["src/app.ts"]),
      commit("fz2", 24, "[F20260801fixz][agent][BugFix] 修 2 (#52)", ["src/app.ts"]),
      commit("fz3", 23, "[F20260801fixz][agent][BugFix] 修 3 (#53)", ["src/app.ts"]),
    ];
    const all = [...chainCommits, ...fixes];

    // 默认阈值 5：app.ts 被排除 → 所有链窗口内相关 commit = 0 → 无触发
    const signals = detectPostMergeFixDensity(all, chains, { now: NOW });
    expect(signals).toHaveLength(0);

    // 反证：阈值 99（不排除）→ 5 条链全触发（排除语义确实生效，而非巧合零触发）
    const signalsNoExclusion = detectPostMergeFixDensity(all, chains, { now: NOW, highFaninThreshold: 99 });
    expect(signalsNoExclusion).toHaveLength(5);
    const sigA = signalsNoExclusion.find(s => s.featureId === "F20260801aaaa")!;
    const dA = sigA.detail!;
    expect(dA.kind).toBe("post_merge_fix_density");
    if (dA.kind === "post_merge_fix_density") {
      expect(dA.excludedHighFaninFiles).toEqual([]);
      expect(dA.fixCommits).toHaveLength(3);
    }
  });

  it("排除清单可见：detail.excludedHighFaninFiles 列出被排除文件（面板不黑箱）", () => {
    // 5 条链各触碰 app.ts（高扇入）+ 各自专属文件；链 A 的 a.ts 上 3 次 bugfix（低扇入）
    const chainCommits = ["a", "b", "c", "d", "e"].flatMap((ch, i) => [
      commit(`${ch}1`, 40 - i, `[F20260801${ch}${ch}bb][agent][New Feature] 引入`, [`src/app.ts`, `src/${ch}.ts`]),
      commit(`${ch}2`, 35 - i, `[F20260801${ch}${ch}bb][agent][Feature Update] 收尾`, [`src/app.ts`, `src/${ch}.ts`]),
    ]);
    const docs = ["a", "b", "c", "d", "e"].map((ch, i) => docOf(`F20260801${ch}${ch}bb`, 40 - i));
    const chains = buildFeatureChains(chainCommits, docs, { now: NOW });

    const fixes = [
      commit("fa1", 25, "[F20260801fixz][agent][BugFix] 修 1 (#61)", ["src/a.ts"]),
      commit("fa2", 24, "[F20260801fixz][agent][BugFix] 修 2 (#62)", ["src/a.ts"]),
      commit("fa3", 23, "[F20260801fixz][agent][BugFix] 修 3 (#63)", ["src/a.ts"]),
    ];
    const all = [...chainCommits, ...fixes];
    const signals = detectPostMergeFixDensity(all, chains, { now: NOW });

    // 只有链 A 触发（a.ts 归它独有；B-E 的专属文件无窗口内 commit，app.ts 被排除）
    const sig = signals.find(s => s.featureId === "F20260801aabb");
    expect(sig).toBeDefined();
    expect(signals).toHaveLength(1);
    const d = sig!.detail!;
    expect(d.kind).toBe("post_merge_fix_density");
    if (d.kind === "post_merge_fix_density") {
      // app.ts 在排除清单里可见（不黑箱）
      expect(d.excludedHighFaninFiles).toContain("src/app.ts");
      expect(d.fixCommits).toHaveLength(3);
    }
  });

  it("窗口未过不报（数据未定型）：合入 5 天前 + 窗口内已有 3 次 bugfix 也不触发", () => {
    const chains = buildFeatureChains([
      commit("z1", 10, "[F20260801zzaa][agent][New Feature] 引入", ["src/z.ts"]),
      commit("z2", 5, "[F20260801zzaa][agent][Feature Update] 收尾", ["src/z.ts"]),
    ], [docOf("F20260801zzaa", 10)], { now: NOW });
    const commits = [
      commit("fz1", 3, "[F20260801fixz][agent][BugFix] 修 1 (#71)", ["src/z.ts"]),
      commit("fz2", 2, "[F20260801fixz][agent][BugFix] 修 2 (#72)", ["src/z.ts"]),
      commit("fz3", 1, "[F20260801fixz][agent][BugFix] 修 3 (#73)", ["src/z.ts"]),
    ];
    const signals = detectPostMergeFixDensity(commits, chains, { now: NOW });
    expect(signals.find(s => s.featureId === "F20260801zzaa")).toBeUndefined();
  });

  it("已接入 detectSignals 主流程（端到端：信号类型可从主入口产出）", () => {
    const chains = buildFeatureChains([
      commit("w1", 30, "[F20260801wwaa][agent][New Feature] 引入", ["src/w.ts"]),
      commit("w2", 25, "[F20260801wwaa][agent][Feature Update] 收尾", ["src/w.ts"]),
    ], [docOf("F20260801wwaa", 30)], { now: NOW });
    const commits = [
      commit("w1", 30, "[F20260801wwaa][agent][New Feature] 引入", ["src/w.ts"]),
      commit("w2", 25, "[F20260801wwaa][agent][Feature Update] 收尾", ["src/w.ts"]),
      commit("f1", 20, "[F20260801fixz][agent][BugFix] 修 1 (#81)", ["src/w.ts"]),
      commit("f2", 18, "[F20260801fixz][agent][BugFix] 修 2 (#82)", ["src/w.ts"]),
      commit("f3", 15, "[F20260801fixz][agent][BugFix] 修 3 (#83)", ["src/w.ts"]),
    ];
    const signals = detectSignals(commits, chains, [], { now: NOW });
    expect(signals.find(s => s.type === "post_merge_fix_density" && s.featureId === "F20260801wwaa")).toBeDefined();
  });
});
