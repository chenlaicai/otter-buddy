import { describe, it, expect } from "vitest";
import { detectSignals } from "@usecases/health/detect-signals";
import type { SignalCommitInput } from "@usecases/health/detect-signals";
import { parseCommit } from "@usecases/health/commit-parser";
import { buildFeatureChains } from "@usecases/health/chain-builder";
import type { CollectedHealingEvent } from "@usecases/health/healing-collector";
import type { SignalDetail } from "@usecases/health/detect-signals";

const NOW = new Date("2026-08-25T12:00:00+08:00");

function dayAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function commit(sha: string, daysAgo: number, message: string, files: string[]): SignalCommitInput {
  return { sha, date: dayAgo(daysAgo), message, parsed: parseCommit(sha, message), filesChanged: files };
}

function healingEvent(id: string, errorType: string, createdDaysAgo = 1): CollectedHealingEvent {
  return {
    id,
    errorType,
    severity: "low",
    status: "open",
    introducedByPr: null,
    createdAt: dayAgo(createdDaysAgo),
    resolvedAt: null,
  };
}

describe("detectSignals", () => {
  it("bug_recurrence：同模块同文件 ≥3 次 bugfix 触发 critical", () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/invoker.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/invoker.ts"]),
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });

    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("critical");
    expect(rec!.filePath).toBe("src/invoker.ts");
    expect(rec!.evidence).toContain("agent");
    expect(rec!.evidence).toContain("3 次");
  });

  it("bug_recurrence 不触发：不同文件 / 次数不足 / 窗口外", () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/a.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/b.ts"]), // 不同文件
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/a.ts"]),
      commit("b4", 45, "[F20260801tstw][agent][BugFix] old (#4)", ["src/a.ts"]), // 30 天窗口外
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("chain_stall：stalled/zombie 链触发 critical（复用 ChainBuilder 判定）", () => {
    const commits = [commit("s1", 20, "[F20260801aaaa][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801aaaa", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = detectSignals(commits, chains, [], { now: NOW });

    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.severity).toBe("critical");
    expect(stall!.featureId).toBe("F20260801aaaa");
    expect(stall!.evidence).toContain("20 天");
  });

  it("重复文件名不去重不双计（Set 防御，审视建议发现 4）", () => {
    // 同 commit 的 filesChanged 含重复文件名：无防御时 shas 双计抬高触发次数、detail 出重复节点。
    // 当前 git --name-only 不产生重复，此用例锁定防御行为不变
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/dup.ts", "src/dup.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/dup.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    // 去重后实际 2 次 < 阈值 3，不触发（不去重则 3 次会误触发）
    expect(signals.find(s => s.type === "bug_recurrence" && s.filePath === "src/dup.ts")).toBeUndefined();
  });

  it("detail 的 date 归一为 Z 格式 ISO（与 chainDetail 端点统一契约，审视建议发现 5）", () => {
    const commits = [
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/iso.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/iso.ts"]),
      commit("b3", 3, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/iso.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 输入是 toISOString() 生成的 Z 格式，归一后仍是 Z 格式（以 Z 结尾）；
    // 若未来采集器改用 %aI 带时区偏移格式，此断言强制归一不变量
    for (const cm of bugRecDetailCommits(rec!.detail)) {
      expect(cm.date.endsWith("Z")).toBe(true);
    }
  });

  it("hotspot：窗口内文件修改次数 > 阈值触发 warning", () => {
    const commits = Array.from({ length: 4 }, (_, i) =>
      commit(`h${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["src/hot.ts"]));
    const signals = detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });

    const hot = signals.find(s => s.type === "hotspot");
    expect(hot).toBeDefined();
    expect(hot!.severity).toBe("warning");
    expect(hot!.evidence).toContain("4 次");
  });

  it("behavior_defect：同一 errorType ≥3 次触发 warning", () => {
    const events = [
      healingEvent("e1", "tool_failure"),
      healingEvent("e2", "tool_failure"),
      healingEvent("e3", "tool_failure"),
      healingEvent("e4", "format_violation"), // 不同类型不合并
    ];
    const signals = detectSignals([], [], events, { now: NOW });

    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.severity).toBe("warning");
    expect(bd!.evidence).toContain("tool_failure");
    expect(bd!.evidence).toContain("3 次");
  });

  it("hotspot_imbalance：bugfix:feature > 2 触发 warning", () => {
    const commits = [
      commit("f1", 1, "[F20260801tstw][agent][New Feature] a", ["a.ts"]),
      commit("b1", 2, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
      commit("b2", 3, "[F20260801tstw][agent][BugFix] 2", ["a.ts"]),
      commit("b3", 4, "[F20260801tstw][agent][BugFix] 3", ["a.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });

    const im = signals.find(s => s.type === "hotspot_imbalance");
    expect(im).toBeDefined();
    expect(im!.severity).toBe("warning");
    expect(im!.evidence).toContain("3:1");
  });

  it("hotspot_imbalance 不触发：feature=0（小样本保护）或比率未超", () => {
    const onlyBugfix = [
      commit("b1", 2, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
      commit("b2", 3, "[F20260801tstw][agent][BugFix] 2", ["a.ts"]),
    ];
    expect(detectSignals(onlyBugfix, [], [], { now: NOW }).find(s => s.type === "hotspot_imbalance"))
      .toBeUndefined();

    const balanced = [
      commit("f1", 1, "[F20260801tstw][agent][New Feature] a", ["a.ts"]),
      commit("f2", 2, "[F20260801tstw][agent][New Feature] b", ["b.ts"]),
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
    ];
    expect(detectSignals(balanced, [], [], { now: NOW }).find(s => s.type === "hotspot_imbalance"))
      .toBeUndefined();
  });

  it("信号结构对齐注册表：name/severity/suggestedAction 来自单一真相源", () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/invoker.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/invoker.ts"]),
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/invoker.ts"]),
    ];
    const [rec] = detectSignals(commits, [], [], { now: NOW });
    expect(rec.name).toBe("bug 反复出现");
    expect(rec.suggestedAction).toBe("强制根因分析");
  });

  it("chain_stall：draft/proposed 文档从未有 commit 不触发（孤儿文档误报修复）", () => {
    // Why: draft/proposed 文档从未开工是常态，不应触发 critical 信号
    const docs = [{
      id: "F20260801draf", title: "t", changeType: "feature", status: "draft",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    // ChainBuilder 判定为 stalled（>14 天无 commit），但 detectChainStall 应过滤掉
    expect(chains[0].state).toBe("stalled");
    const signals = detectSignals([], chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
  });

  it("chain_stall：development 文档从未有 commit 仍触发（用 createdAt 计算天数）", () => {
    // Why: development 状态文档从未有 commit 仍值得关注，但证据应基于 createdAt
    const docs = [{
      id: "F20260801dev0", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/y.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    expect(chains[0].state).toBe("stalled");
    const signals = detectSignals([], chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.evidence).toContain("40 天"); // 基于 createdAt，不是 "null 天"
  });

  it("hotspot：测试文件不进入热点检测", () => {
    const testFiles = [
      "tests/api/helpers.ts",
      "tests/usecases/health/detect-signals.test.ts",
      "src/__tests__/foo.ts",
      "src/bar.spec.ts",
    ];
    const commits = Array.from({ length: 12 }, (_, i) =>
      commit(`t${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, [testFiles[i % testFiles.length]]));
    const signals = detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    expect(signals.find(s => s.type === "hotspot")).toBeUndefined();
  });

  it("hotspot：源码文件仍正常检测（测试文件排除不影响源码）", () => {
    const commits = [
      ...Array.from({ length: 5 }, (_, i) =>
        commit(`ts${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["tests/foo.test.ts"])),
      ...Array.from({ length: 5 }, (_, i) =>
        commit(`to${i}`, i + 6, `[F20260801tstw][agent][Feature Update] ${i}`, ["src/core.ts"])),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    const hot = signals.find(s => s.type === "hotspot");
    expect(hot).toBeDefined();
    expect(hot!.filePath).toBe("src/core.ts");
  });

  it("chain_stall：design 文档从未有 commit 不触发（design 状态过滤）", () => {
    // Why: design 文档从未开工是常态（项目规划阶段），不应触发 critical 信号
    const docs = [{
      id: "F20260801desg", title: "t", changeType: "feature", status: "design",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/z.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    // ChainBuilder 判定为 stalled（>14 天无 commit），但 detectChainStall 应过滤掉
    expect(chains[0].state).toBe("stalled");
    const signals = detectSignals([], chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
  });

  it("hotspot：大写 Tests/ 目录也排除（大小写不敏感）", () => {
    // Why: 某些项目使用大写 Tests/ 目录，应同样排除
    const commits = Array.from({ length: 12 }, (_, i) =>
      commit(`tc${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["Tests/helpers.ts"]));
    const signals = detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    expect(signals.find(s => s.type === "hotspot")).toBeUndefined();
  });
});


/** 类型收窄 helper（#647 SignalDetail 联合化后）：取 bug_recurrence detail 的 commits */
function bugRecDetailCommits(detail: SignalDetail | undefined): Array<{ sha: string; date: string; changeType: string | null; message: string }> {
  if (!detail || detail.kind !== "bug_recurrence_commits") return [];
  return detail.commits;
}

describe("Issue #644：结构化证据 + 置信度", () => {
  it("bug_recurrence 的 detail 含全类型 commit 序列（不只 bugfix，交替节奏可画）", () => {
    const commits = [
      commit("f1", 10, "[F20260801tstw][agent][New Feature] 引入", ["src/x.ts"]),
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 修1 (#1)", ["src/x.ts"]),
      commit("f2", 6, "[F20260801tstw][agent][Feature Update] 增强", ["src/x.ts"]),
      commit("b2", 4, "[F20260801tstw][agent][BugFix] 修2 (#2)", ["src/x.ts"]),
      commit("b3", 2, "[F20260801tstw][agent][BugFix] 修3 (#3)", ["src/x.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.detail).toBeDefined();
    expect(rec!.detail!.kind).toBe("bug_recurrence_commits");
    // 全类型：3 bugfix + 1 New Feature + 1 Feature Update = 5 个节点
    expect(bugRecDetailCommits(rec!.detail)).toHaveLength(5);
    // 时间升序
    const dates = bugRecDetailCommits(rec!.detail).map(c => c.date);
    expect([...dates].sort()).toEqual(dates);
    // changeType 标注交替（第一个是引入非 bugfix）
    expect(bugRecDetailCommits(rec!.detail)[0]!.changeType).toBe("New Feature");
    expect(bugRecDetailCommits(rec!.detail).filter(c => c.changeType === "BugFix")).toHaveLength(3);
  });

  it("detail 窗口滑动整体重算：出窗 commit 不出现在 detail", () => {
    const commits = [
      commit("old", 45, "[F20260801tstw][agent][BugFix] 出窗", ["src/y.ts"]),
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/y.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/y.ts"]),
      commit("b3", 3, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/y.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(bugRecDetailCommits(rec!.detail)).toHaveLength(3);
    expect(bugRecDetailCommits(rec!.detail).every(c => c.sha !== "old")).toBe(true);
  });

  it("chain_stall 置信规则甲：stalled ∧ 有 commit → low；zombie/doc-only → normal", () => {
    // 滞留但链上有 commit（「干完没归档」主场景）
    const commits = [commit("s1", 20, "[F20260801aaaa][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801aaaa", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.confidence).toBe("low"); // 有 commit 的滞留 → low

    // doc-only development 滞留（无 commit）→ normal（更接近真异常）
    const docs2 = [{
      id: "F20260801bbbb", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/y.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains2 = buildFeatureChains([], docs2, { now: NOW });
    const signals2 = detectSignals([], chains2, [], { now: NOW });
    const stall2 = signals2.find(s => s.type === "chain_stall");
    expect(stall2).toBeDefined();
    expect(stall2!.confidence).toBe("normal");
  });

  it("chain-builder 白名单收编 active：status: active 的滞留链参与病态判定", () => {
    // Issue #644 止血：41 篇 status:active 文档原先被当终态静默豁免
    const commits = [commit("s1", 20, "[F20260801actv][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801actv", title: "t", changeType: "feature", status: "active",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/a.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    expect(chains[0].state).toBe("stalled"); // 不再豁免
    const signals = detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.confidence).toBe("low");
  });

  it("置信规则甲 zombie 分支：30 天无 commit 且零提及 → normal（更接近真异常，不降置信）（审视发现 3）", () => {
    // 规则甲的对照分支：stalled→low 依赖 zombie→normal 的对比才成立。
    // 原先只有代码注释保证，无直接用例锁定
    const commits = [commit("s1", 45, "[F20260801zomb][agent][New Feature] x", ["a.ts"])]; // 45 天前最后 commit（> zombieDays 30）
    const docs = [{
      id: "F20260801zomb", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/z.md", createdAt: dayAgo(50), createdInConversationId: null,
    }];
    // 提及 Map 显式 0（未传 Map = 未查询不判 zombie，冷启动安全，见 isZombie）
    const fidMentionCounts = new Map([["F20260801zomb", 0]]);
    const chains = buildFeatureChains(commits, docs, { now: NOW, fidMentionCounts });
    expect(chains[0].state).toBe("zombie");
    const signals = detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.confidence).toBe("normal"); // zombie 不降置信
    expect(stall!.evidence).toContain("僵尸");
  });
});

describe("Issue #645：僵尸链阶梯", () => {
  function zombieFixture(fid: string, commitDaysAgo: number, docCreatedDaysAgo: number) {
    const commits = [commit("s1", commitDaysAgo, `[${fid}][agent][New Feature] x`, ["a.ts"])];
    const docs = [{
      id: fid, title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: `docs/features/${fid}.md`, createdAt: dayAgo(docCreatedDaysAgo), createdInConversationId: null,
    }];
    const fidMentionCounts = new Map([[fid, 0]]);
    const chains = buildFeatureChains(commits, docs, { now: NOW, fidMentionCounts });
    expect(chains[0]!.state).toBe("zombie");
    return detectSignals(commits, chains, [], { now: NOW }).find(s => s.type === "chain_stall")!;
  }

  it("30-60 天黄档：severity 降为 warning，suggestedAction=观察", () => {
    const stall = zombieFixture("F20260801warn", 35, 40);
    expect(stall.severity).toBe("warning");
    expect(stall.evidence).toContain("黄档");
    expect(stall.evidence).toContain("35 天");
    expect(stall.suggestedAction).toContain("观察");
    expect(stall.confidence).toBe("normal"); // #644 语义不变：zombie 不降置信
  });

  it("边界：恰好 30 天进黄档（isZombie 的 zombieDays 默认 30 已拦 <30）", () => {
    const stall = zombieFixture("F20260801bt33", 30, 40);
    expect(stall.severity).toBe("warning");
    expect(stall.evidence).toContain("黄档");
  });

  it("60-90 天红档：critical + 强制复盘 action（恰好 60 天进红档）", () => {
    const stall = zombieFixture("F20260801red6", 60, 70);
    expect(stall.severity).toBe("critical");
    expect(stall.evidence).toContain("红档");
    expect(stall.evidence).toContain("60 天");
    expect(stall.suggestedAction).toContain("链复盘");
  });

  it("≥90 天归档档：critical + evidence 建议归档 + suggestedAction 指向归档动作（消费者拿得起）", () => {
    const stall = zombieFixture("F20260801arc9", 95, 100);
    expect(stall.severity).toBe("critical");
    expect(stall.evidence).toContain("归档");
    expect(stall.evidence).toContain("95 天");
    expect(stall.suggestedAction).toContain("归档 issue");
    expect(stall.suggestedAction).toContain("archived");
  });

  it("stalled 分支不受阶梯影响：仍 critical + 规则甲置信（14 天滞留）", () => {
    const commits = [commit("s1", 20, "[F20260801staz][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801staz", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    expect(chains[0]!.state).toBe("stalled");
    const stall = detectSignals(commits, chains, [], { now: NOW }).find(s => s.type === "chain_stall")!;
    expect(stall.severity).toBe("critical"); // 注册表默认，阶梯只作用于 zombie
    expect(stall.evidence).not.toContain("黄档");
    expect(stall.confidence).toBe("low"); // stalled ∧ 有 commit → low
  });
});

describe("Issue #645：behavior_defect 窗口化", () => {
  it("behavior_defect 窗口化（Issue #645）：7 天外的旧事件不抬计数，聚合按时间排序", () => {
    // 老实现（全量聚合）：5 次会触发且证据无窗口；新实现：窗口内只有 3 次仍触发但计数为 3
    const events = [
      healingEvent("old1", "degenerate", 8),  // 窗口外
      healingEvent("old2", "degenerate", 10), // 窗口外
      healingEvent("w1", "degenerate", 6),
      healingEvent("w2", "degenerate", 3),
      healingEvent("w3", "degenerate", 1),
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("7 天内复发 3 次"); // 不含窗口外事件
    expect(bd!.evidence).toContain("阈值 3");
    // 日期范围：窗口内最早 ~ 最晚
    expect(bd!.evidence).toContain(dayAgo(6).slice(0, 10));
    expect(bd!.evidence).toContain(dayAgo(1).slice(0, 10));
  });

  it("behavior_defect 窗口化：全量超阈值但窗口内不足 → 不触发（窗口化语义核心差异）", () => {
    // degenerate 57 次/12 天场景的微缩：总量大但近 7 天只有 2 次 → 不再永久占用警报位
    const events = [
      ...Array.from({ length: 10 }, (_, i) => healingEvent(`h${i}`, "degenerate", 8 + i)),
      healingEvent("r1", "degenerate", 3),
      healingEvent("r2", "degenerate", 1),
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    expect(signals.find(s => s.type === "behavior_defect")).toBeUndefined();
  });

  it("behavior_defect 阈值边界：恰好 3 次触发，2 次不触发（空窗口同不触发）", () => {
    const two = [
      healingEvent("a", "tool_failure"),
      healingEvent("b", "tool_failure"),
    ];
    expect(detectSignals([], [], two, { now: NOW }).find(s => s.type === "behavior_defect")).toBeUndefined();

    const three = [
      healingEvent("a", "tool_failure", 5),
      healingEvent("b", "tool_failure", 3),
      healingEvent("c", "tool_failure", 1),
    ];
    expect(detectSignals([], [], three, { now: NOW }).find(s => s.type === "behavior_defect")).toBeDefined();

    // 空窗口：无任何事件
    expect(detectSignals([], [], [], { now: NOW }).find(s => s.type === "behavior_defect")).toBeUndefined();
  });

  it("behavior_defect：behaviorWindowDays/behaviorThreshold 参数可调（独立于 recurrence 阈值）", () => {
    const events = [
      healingEvent("a", "degenerate", 10), // 默认 7 天窗外，12 天窗内
      healingEvent("b", "degenerate", 6),
      healingEvent("c", "degenerate", 1),
    ];
    // 默认 7 天窗口：2 次 < 3 不触发
    expect(detectSignals([], [], events, { now: NOW }).find(s => s.type === "behavior_defect")).toBeUndefined();
    // 12 天窗口：3 次触发
    const widened = detectSignals([], [], events, { now: NOW, behaviorWindowDays: 12 });
    expect(widened.find(s => s.type === "behavior_defect")).toBeDefined();
    expect(widened.find(s => s.type === "behavior_defect")!.evidence).toContain("12 天内复发 3 次");
    // 阈值调高：同数据 12 天窗 + 阈值 4 不触发（behaviorThreshold 独立于 recurrenceThreshold）
    expect(detectSignals([], [], events, { now: NOW, behaviorWindowDays: 12, behaviorThreshold: 4, recurrenceThreshold: 1 })
      .find(s => s.type === "behavior_defect")).toBeUndefined();
  });

});
