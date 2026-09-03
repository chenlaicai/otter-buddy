import { describe, it, expect } from "vitest";
import { buildFeatureChains } from "@usecases/health/chain-builder";
import type { ChainCommitInput, ChainBuildOptions } from "@usecases/health/chain-builder";
import type { OpenPrInfo } from "@usecases/health/pr-collector";
import type { CollectedFeatureDoc } from "@usecases/health/feature-doc-collector";
import { parseCommit } from "@usecases/health/commit-parser";

/**
 * F20260902sigm 链路信号模型测试：
 * - zombie/doc-only 判死用例已删（判定本身已删）
 * - stalled 语义 = pr-stalled（open PR >7 天无推进），不再看 daysSinceLastCommit
 * - 判据 100% 来自 git/PR 事实，docStatus 不参与（status 值不再影响判定）
 */

/** now 固定：2026-08-25，测试内日期相对它偏移 */
const NOW = new Date("2026-08-25T12:00:00+08:00");

function dayAgo(days: number): string {
  const d = new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function commit(sha: string, daysAgo: number, message: string, files: string[]): ChainCommitInput {
  return { sha, date: dayAgo(daysAgo), message, parsed: parseCommit(sha, message), filesChanged: files };
}

function doc(id: string, status: string, createdDaysAgo = 40): CollectedFeatureDoc {
  return {
    id,
    title: `doc ${id}`,
    changeType: "feature",
    status,
    substatus: null,
    tags: [],
    modules: [],
    causalLinksFrom: [],
    supersedes: [],
    filePath: `docs/features/${id}.md`,
    createdAt: dayAgo(createdDaysAgo),
    createdInConversationId: null,
  };
}

function pr(number: number, featureIds: string[], lastActivityDaysAgo: number): OpenPrInfo {
  return {
    number,
    title: `PR ${number}`,
    headRefName: `feature/pr-${number}`,
    body: null,
    url: `https://example.com/pr/${number}`,
    createdAt: dayAgo(lastActivityDaysAgo + 5),
    lastActivityAt: dayAgo(lastActivityDaysAgo),
    featureIds,
  };
}

const OPTS: ChainBuildOptions = { now: NOW };

describe("buildFeatureChains", () => {
  it("按 FID 聚合 commit，时间序升序，派生计数正确", () => {
    const commits = [
      commit("sha2", 5, "[F20260801aaaa][agent][BugFix] 修 b (#2)", ["src/b.ts"]),
      commit("sha1", 20, "[F20260801aaaa][agent][New Feature] 建 a (#1)", ["src/a.ts", "src/b.ts"]),
    ];
    const chains = buildFeatureChains(commits, [doc("F20260801aaaa", "development")], OPTS);
    expect(chains).toHaveLength(1);
    const c = chains[0]!;
    expect(c.commitCount).toBe(2);
    expect(c.bugfixCount).toBe(1);
    expect(c.commits.map(x => x.sha)).toEqual(["sha1", "sha2"]);
    expect(c.firstSeenAt?.toISOString()).toBe(dayAgo(20));
    expect(c.lastCommitAt?.toISOString()).toBe(dayAgo(5));
    expect(c.daysSinceLastCommit).toBe(5);
  });

  it("active：链上事实健康（无信号），docStatus 不影响判定（docStatus 退役）", () => {
    // 终态文档（implemented）+ 近期 commit：旧模型豁免病态判定，新模型一视同仁判 active
    const commits = [commit("s1", 3, "[F20260801bbbb][agent][New Feature] x", ["a.ts"])];
    const chains = buildFeatureChains(commits, [doc("F20260801bbbb", "implemented")], OPTS);
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals).toEqual([]);

    // 45 天无 commit 但 status=development：不再判 stalled（静默=稳定默认态，不预言）
    const commits2 = [commit("s2", 45, "[F20260802bbbb][agent][New Feature] x", ["a.ts"])];
    const chains2 = buildFeatureChains(commits2, [doc("F20260802bbbb", "development")], OPTS);
    expect(chains2[0]!.state).toBe("active");
    expect(chains2[0]!.signals).toEqual([]);
  });

  it("regressed：链尾 BugFix 触碰链内早前文件（无 inFlight 前提——T4 修复合入后回退漏报）", () => {
    // 文档终态（implemented）：旧模型因 inFlight 前提漏报，新模型必报
    const commits = [
      commit("s1", 20, "[F20260801dddd][agent][New Feature] x", ["src/a.ts"]),
      commit("s2", 5, "[F20260801dddd][agent][BugFix] 修 a (#9)", ["src/a.ts"]),
    ];
    const chains = buildFeatureChains(commits, [doc("F20260801dddd", "implemented")], OPTS);
    expect(chains[0]!.state).toBe("regressed");
    expect(chains[0]!.signals.map(s => s.id)).toContain("regressed");
    expect(chains[0]!.signals.find(s => s.id === "regressed")!.evidence).toContain("s2");
  });

  it("非 regressed：BugFix 不触碰链内文件（文件交集为空）", () => {
    const commits = [
      commit("s1", 20, "[F20260801eeee][agent][New Feature] x", ["src/a.ts"]),
      commit("s2", 5, "[F20260801eeee][agent][BugFix] 修别的 (#9)", ["src/z.ts"]),
    ];
    const chains = buildFeatureChains(commits, [doc("F20260801eeee", "development")], OPTS);
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals.map(s => s.id)).not.toContain("regressed");
  });

  it("orphan（doc-gap）：commit 的 FID 无文档", () => {
    const commits = [commit("s1", 3, "[F20260802cccc][agent][New Feature] x", ["a.ts"])];
    const chains = buildFeatureChains(commits, [], OPTS);
    expect(chains[0]!.state).toBe("orphan");
    expect(chains[0]!.signals.map(s => s.id)).toEqual(["doc-gap"]);
    expect(chains[0]!.doc).toBeNull();
  });

  it("doc-only 链：有文档无 commit → 稳定（active、零信号），无论 status/创建多久", () => {
    // 「写了文档没动工」不是病：245 篇零 commit 文档是本仓常态（方案 R6）
    const docs = [
      doc("F20260101oldd", "development", 400),
      doc("F20260301oldz", "draft", 500),
      doc("F20260601olds", "implemented", 90),
    ];
    const chains = buildFeatureChains([], docs, OPTS);
    for (const c of chains) {
      expect(c.state).toBe("active");
      expect(c.signals).toEqual([]);
      expect(c.daysSinceLastCommit).toBeNull();
    }
  });

  it("无 FID 的 commit 不进链", () => {
    const commits = [commit("s1", 3, "Merge branch 'x' into main", [])];
    const chains = buildFeatureChains(commits, [], OPTS);
    expect(chains).toHaveLength(0);
  });

  it("信号叠加：orphan 链上链尾 BugFix → doc-gap + regressed 同时挂（不合并不取最严重）", () => {
    const commits = [
      commit("s1", 45, "[F20260802ffff][agent][New Feature] x", ["a.ts"]),
      commit("s2", 3, "[F20260802ffff][agent][BugFix] 修 (#9)", ["a.ts"]),
    ];
    const chains = buildFeatureChains(commits, [], OPTS);
    expect(chains[0]!.signals.map(s => s.id).sort()).toEqual(["doc-gap", "regressed"]);
    // state 投影仍单值：orphan 优先
    expect(chains[0]!.state).toBe("orphan");
  });
});

describe("pr-stalled（open PR 停滞信号）", () => {
  const baseCommits = (fid: string) => [commit("s1", 3, `[${fid}][agent][New Feature] x`, ["a.ts"])];

  it("链上 open PR >7 天无推进 → stalled 投影 + pr-stalled 信号", () => {
    const chains = buildFeatureChains(baseCommits("F20260901praa"), [doc("F20260901praa", "development")], {
      ...OPTS,
      openPrs: [pr(101, ["F20260901praa"], 10)],
    });
    expect(chains[0]!.state).toBe("stalled");
    const sig = chains[0]!.signals.find(s => s.id === "pr-stalled");
    expect(sig).toBeDefined();
    expect(sig!.stalledPrs).toEqual([{ number: 101, url: "https://example.com/pr/101", daysSinceActivity: 10 }]);
    expect(sig!.evidence).toContain("#101");
    expect(sig!.evidence).toContain("10 天");
  });

  it("open PR 7 天内有推进 → 无信号（阈值边界：>7 判定）", () => {
    const chains = buildFeatureChains(baseCommits("F20260901prbb"), [doc("F20260901prbb", "development")], {
      ...OPTS,
      openPrs: [pr(102, ["F20260901prbb"], 7)],
    });
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals).toEqual([]);
  });

  it("链最后 commit 很久（>14 天）但无 open PR → 不判 stalled（旧 stalled 语义删除）", () => {
    const commits = [commit("s1", 45, "[F20260901prcc][agent][New Feature] x", ["a.ts"])];
    const chains = buildFeatureChains(commits, [doc("F20260901prcc", "development")], OPTS);
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals).toEqual([]);
  });

  it("多 FID 一对多：跨链 PR 挂到每条命中链", () => {
    const commits = [
      commit("s1", 3, "[F20260901prdd][agent][New Feature] x", ["a.ts"]),
      commit("s2", 3, "[F20260901pree][agent][New Feature] y", ["b.ts"]),
    ];
    const chains = buildFeatureChains(commits, [doc("F20260901prdd", "development"), doc("F20260901pree", "development")], {
      ...OPTS,
      openPrs: [pr(103, ["F20260901prdd", "F20260901pree"], 12)],
    });
    const d = chains.find(c => c.featureId === "F20260901prdd")!;
    const e = chains.find(c => c.featureId === "F20260901pree")!;
    expect(d.signals.find(s => s.id === "pr-stalled")).toBeDefined();
    expect(e.signals.find(s => s.id === "pr-stalled")).toBeDefined();
    expect(d.state).toBe("stalled");
    expect(e.state).toBe("stalled");
  });

  it("一条链挂多个停滞 PR：信号逐条列出（可叠加）", () => {
    const chains = buildFeatureChains(baseCommits("F20260901prff"), [doc("F20260901prff", "development")], {
      ...OPTS,
      openPrs: [pr(104, ["F20260901prff"], 9), pr(105, ["F20260901prff"], 20)],
    });
    const sig = chains[0]!.signals.find(s => s.id === "pr-stalled")!;
    expect(sig.stalledPrs).toHaveLength(2);
    expect(sig.evidence).toContain("#104");
    expect(sig.evidence).toContain("#105");
  });

  it("停滞 PR + 近期推进 PR 并存：只报停滞的（推进刷新消失条件）", () => {
    const chains = buildFeatureChains(baseCommits("F20260901prgg"), [doc("F20260901prgg", "development")], {
      ...OPTS,
      openPrs: [pr(106, ["F20260901prgg"], 30), pr(107, ["F20260901prgg"], 2)],
    });
    const sig = chains[0]!.signals.find(s => s.id === "pr-stalled")!;
    expect(sig.stalledPrs).toHaveLength(1);
    expect(sig.stalledPrs![0]!.number).toBe(106);
  });

  it("PR lastActivity 为 null（无活动数据）→ 不判停滞（不猜）", () => {
    const nullPr: OpenPrInfo = { ...pr(108, ["F20260901prhh"], 10), lastActivityAt: null };
    const chains = buildFeatureChains(baseCommits("F20260901prhh"), [doc("F20260901prhh", "development")], {
      ...OPTS,
      openPrs: [nullPr],
    });
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals).toEqual([]);
  });

  it("PR viewFailed=true → 不判停滞（未知数据不猜）但 unknownPrCount 可观测", () => {
    const viewFailedPr: OpenPrInfo = { ...pr(112, ["F20260901prkk"], 10), viewFailed: true };
    const chains = buildFeatureChains(baseCommits("F20260901prkk"), [doc("F20260901prkk", "development")], {
      ...OPTS,
      openPrs: [viewFailedPr],
    });
    expect(chains[0]!.state).toBe("active");
    expect(chains[0]!.signals).toEqual([]);
    expect(chains[0]!.unknownPrCount).toBe(1);
  });

  it("PR 混合（viewFailed + 正常）→ 只对正常 PR 判定停滞，unknownPrCount 累计", () => {
    const viewFailedPr: OpenPrInfo = { ...pr(113, ["F20260901prll"], 10), viewFailed: true };
    const normalPr = pr(114, ["F20260901prll"], 15);
    const chains = buildFeatureChains(baseCommits("F20260901prll"), [doc("F20260901prll", "development")], {
      ...OPTS,
      openPrs: [viewFailedPr, normalPr],
    });
    expect(chains[0]!.state).toBe("stalled");
    const sig = chains[0]!.signals.find(s => s.id === "pr-stalled");
    expect(sig).toBeDefined();
    expect(sig!.stalledPrs).toHaveLength(1);
    expect(sig!.stalledPrs![0]!.number).toBe(114);
    expect(chains[0]!.unknownPrCount).toBe(1);
  });

  it("stalledPrDays 可配（options 模式，方案 R7 首期可配）", () => {
    const chains = buildFeatureChains(baseCommits("F20260901prii"), [doc("F20260901prii", "development")], {
      ...OPTS,
      stalledPrDays: 14,
      openPrs: [pr(109, ["F20260901prii"], 10)],
    });
    expect(chains[0]!.signals.find(s => s.id === "pr-stalled")).toBeUndefined();

    const chains2 = buildFeatureChains(baseCommits("F20260901prii"), [doc("F20260901prii", "development")], {
      ...OPTS,
      stalledPrDays: 14,
      openPrs: [pr(110, ["F20260901prii"], 20)],
    });
    expect(chains2[0]!.signals.find(s => s.id === "pr-stalled")).toBeDefined();
  });

  it("PR 无关联 FID（如 dependabot）→ 不挂任何链", () => {
    const chains = buildFeatureChains(baseCommits("F20260901prjj"), [doc("F20260901prjj", "development")], {
      ...OPTS,
      openPrs: [pr(111, [], 60)],
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]!.signals).toEqual([]);
  });
});
