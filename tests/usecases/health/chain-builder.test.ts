import { describe, it, expect } from "vitest";
import { buildFeatureChains } from "@usecases/health/chain-builder";
import type { ChainCommitInput, ChainBuildOptions } from "@usecases/health/chain-builder";
import type { CollectedFeatureDoc } from "@usecases/health/feature-doc-collector";
import { parseCommit } from "@usecases/health/commit-parser";

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
    tags: [],
    modules: [],
    causalLinksFrom: [],
    supersedes: [],
    filePath: `docs/features/${id}.md`,
    createdAt: dayAgo(createdDaysAgo),
    createdInConversationId: null,
  };
}

const OPTS: ChainBuildOptions = { now: NOW };

describe("buildFeatureChains", () => {
  it("按 FID 聚合 commit，时间序升序，派生计数正确", () => {
    const commits = [
      commit("sha2", 5, "[F20260801aaaa][agent][BugFix] 修 b (#2)", ["src/b.ts"]),
      commit("sha1", 20, "[F20260801aaaa][agent][New Feature] 建 a (#1)", ["src/a.ts", "src/b.ts"]),
    ];
    const chains = buildFeatureChains(commits, [], OPTS);

    expect(chains).toHaveLength(1);
    const c = chains[0];
    expect(c.featureId).toBe("F20260801aaaa");
    expect(c.commitCount).toBe(2);
    expect(c.bugfixCount).toBe(1);
    expect(c.commits.map(x => x.sha)).toEqual(["sha1", "sha2"]); // 升序
    expect(c.daysSinceLastCommit).toBe(5);
    expect(c.touchFiles.size).toBe(2);
  });

  it("active：文档在途 ∧ 最后 commit ≤14 天", () => {
    const chains = buildFeatureChains(
      [commit("s1", 3, "[F20260801bbbb][agent][New Feature] x", ["a.ts"])],
      [doc("F20260801bbbb", "development")],
      OPTS,
    );
    expect(chains[0].state).toBe("active");
  });

  it("stalled：文档在途 ∧ >14 天无 commit", () => {
    const chains = buildFeatureChains(
      [commit("s1", 20, "[F20260801cccc][agent][New Feature] x", ["a.ts"])],
      [doc("F20260801cccc", "development")],
      OPTS,
    );
    expect(chains[0].state).toBe("stalled");
  });

  it("regressed：最新 commit 是 BugFix 且触碰链内早前文件", () => {
    const chains = buildFeatureChains(
      [
        commit("s1", 20, "[F20260801dddd][agent][New Feature] x", ["src/a.ts"]),
        commit("s2", 5, "[F20260801dddd][agent][BugFix] 修 a (#9)", ["src/a.ts"]),
      ],
      [doc("F20260801dddd", "development")],
      OPTS,
    );
    expect(chains[0].state).toBe("regressed");
  });

  it("非 regressed：BugFix 不触碰链内文件（文件交集为空）", () => {
    const chains = buildFeatureChains(
      [
        commit("s1", 20, "[F20260801eeee][agent][New Feature] x", ["src/a.ts"]),
        commit("s2", 5, "[F20260801eeee][agent][BugFix] 修别的 (#9)", ["src/z.ts"]),
      ],
      [doc("F20260801eeee", "development")],
      OPTS,
    );
    expect(chains[0].state).toBe("active");
  });

  it("zombie：>30 天无 commit ∧ 提及数=0（fidMentionCounts 显式给出）", () => {
    const chains = buildFeatureChains(
      [commit("s1", 45, "[F20260801ffff][agent][New Feature] x", ["a.ts"])],
      [doc("F20260801ffff", "development")],
      { ...OPTS, fidMentionCounts: new Map([["F20260801ffff", 0]]) },
    );
    expect(chains[0].state).toBe("zombie");
  });

  it("非 zombie：>30 天无 commit 但近 30 天有提及（有人在聊它）", () => {
    const chains = buildFeatureChains(
      [commit("s1", 45, "[F20260802aaaa][agent][New Feature] x", ["a.ts"])],
      [doc("F20260802aaaa", "development")],
      { ...OPTS, fidMentionCounts: new Map([["F20260802aaaa", 3]]) },
    );
    expect(chains[0].state).toBe("stalled"); // 提及救活 zombie 判定，但仍是 stalled
  });

  it("zombie 需要 fidMentionCounts 显式传入，否则降级为 stalled（冷启动安全）", () => {
    const chains = buildFeatureChains(
      [commit("s1", 45, "[F20260802bbbb][agent][New Feature] x", ["a.ts"])],
      [doc("F20260802bbbb", "development")],
      OPTS, // 无 fidMentionCounts
    );
    expect(chains[0].state).toBe("stalled");
  });

  it("orphan：commit 的 FID 无文档", () => {
    const chains = buildFeatureChains(
      [commit("s1", 3, "[F20260802cccc][agent][New Feature] x", ["a.ts"])],
      [], // 无文档
      OPTS,
    );
    expect(chains[0].state).toBe("orphan");
    expect(chains[0].doc).toBeNull();
  });

  it("终态文档（implemented）不判 stalled/zombie", () => {
    const chains = buildFeatureChains(
      [commit("s1", 45, "[F20260802dddd][agent][New Feature] x", ["a.ts"])],
      [doc("F20260802dddd", "implemented")],
      { ...OPTS, fidMentionCounts: new Map([["F20260802dddd", 0]]) },
    );
    expect(chains[0].state).toBe("active");
  });

  it("doc-only 链：有文档无 commit，按 createdAt 判定", () => {
    const chains = buildFeatureChains([], [doc("F20260802eeee", "development", 20)], OPTS);
    expect(chains[0].state).toBe("stalled");
    expect(chains[0].commitCount).toBe(0);
  });

  it("无 FID 的 commit 不进链", () => {
    const chains = buildFeatureChains(
      [commit("s1", 3, "Merge branch 'x' into main", [])],
      [],
      OPTS,
    );
    expect(chains).toHaveLength(0);
  });

  it("病态优先级：orphan 压过其他判定", () => {
    const chains = buildFeatureChains(
      [commit("s1", 45, "[F20260802ffff][agent][BugFix] x", ["a.ts"])],
      [],
      { ...OPTS, fidMentionCounts: new Map([["F20260802ffff", 0]]) },
    );
    expect(chains[0].state).toBe("orphan");
  });
});
