import { describe, it, expect } from "vitest";
import { detectSignals } from "@usecases/health/detect-signals";
import type { SignalCommitInput } from "@usecases/health/detect-signals";
import { parseCommit } from "@usecases/health/commit-parser";
import { buildFeatureChains } from "@usecases/health/chain-builder";
import type { CollectedHealingEvent } from "@usecases/health/healing-collector";

const NOW = new Date("2026-08-25T12:00:00+08:00");

function dayAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function commit(sha: string, daysAgo: number, message: string, files: string[]): SignalCommitInput {
  return { sha, date: dayAgo(daysAgo), message, parsed: parseCommit(sha, message), filesChanged: files };
}

function healingEvent(id: string, errorType: string): CollectedHealingEvent {
  return {
    id,
    errorType,
    severity: "low",
    status: "open",
    introducedByPr: null,
    createdAt: dayAgo(1),
    resolvedAt: null,
  };
}

describe("detectSignals", () => {
  it("bug_recurrence：同模块同文件 ≥3 次 bugfix 触发 critical", async () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/invoker.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/invoker.ts"]),
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/invoker.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });

    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("critical");
    expect(rec!.filePath).toBe("src/invoker.ts");
    expect(rec!.evidence).toContain("agent");
    expect(rec!.evidence).toContain("3 次");
  });

  it("bug_recurrence 不触发：不同文件 / 次数不足 / 窗口外", async () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/a.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/b.ts"]), // 不同文件
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/a.ts"]),
      commit("b4", 45, "[F20260801tstw][agent][BugFix] old (#4)", ["src/a.ts"]), // 30 天窗口外
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("chain_stall：stalled/zombie 链触发 critical（复用 ChainBuilder 判定）", async () => {
    const commits = [commit("s1", 20, "[F20260801aaaa][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801aaaa", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = await detectSignals(commits, chains, [], { now: NOW });

    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.severity).toBe("critical");
    expect(stall!.featureId).toBe("F20260801aaaa");
    expect(stall!.evidence).toContain("20 天");
  });

  it("重复文件名不去重不双计（Set 防御，审视建议发现 4）", async () => {
    // 同 commit 的 filesChanged 含重复文件名：无防御时 shas 双计抬高触发次数、detail 出重复节点。
    // 当前 git --name-only 不产生重复，此用例锁定防御行为不变
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/dup.ts", "src/dup.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/dup.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });
    // 去重后实际 2 次 < 阈值 3，不触发（不去重则 3 次会误触发）
    expect(signals.find(s => s.type === "bug_recurrence" && s.filePath === "src/dup.ts")).toBeUndefined();
  });

  it("detail 的 date 归一为 Z 格式 ISO（与 chainDetail 端点统一契约，审视建议发现 5）", async () => {
    const commits = [
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/iso.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/iso.ts"]),
      commit("b3", 3, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/iso.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 输入是 toISOString() 生成的 Z 格式，归一后仍是 Z 格式（以 Z 结尾）；
    // 若未来采集器改用 %aI 带时区偏移格式，此断言强制归一不变量
    if (rec!.detail!.kind !== "bug_recurrence_commits") throw new Error("kind 不符");
    for (const cm of rec!.detail!.commits) {
      expect(cm.date.endsWith("Z")).toBe(true);
    }
  });

  it("hotspot：窗口内文件修改次数 > 阈值触发 warning", async () => {
    const commits = Array.from({ length: 4 }, (_, i) =>
      commit(`h${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["src/hot.ts"]));
    const signals = await detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });

    const hot = signals.find(s => s.type === "hotspot");
    expect(hot).toBeDefined();
    expect(hot!.severity).toBe("warning");
    expect(hot!.evidence).toContain("4 次");
  });

  it("behavior_defect：同一 errorType ≥3 次触发 warning", async () => {
    const events = [
      healingEvent("e1", "tool_failure"),
      healingEvent("e2", "tool_failure"),
      healingEvent("e3", "tool_failure"),
      healingEvent("e4", "format_violation"), // 不同类型不合并
    ];
    const signals = await detectSignals([], [], events, { now: NOW });

    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.severity).toBe("warning");
    expect(bd!.evidence).toContain("tool_failure");
    expect(bd!.evidence).toContain("3 次");
  });

  it("hotspot_imbalance：bugfix:feature > 2 触发 warning", async () => {
    const commits = [
      commit("f1", 1, "[F20260801tstw][agent][New Feature] a", ["a.ts"]),
      commit("b1", 2, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
      commit("b2", 3, "[F20260801tstw][agent][BugFix] 2", ["a.ts"]),
      commit("b3", 4, "[F20260801tstw][agent][BugFix] 3", ["a.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });

    const im = signals.find(s => s.type === "hotspot_imbalance");
    expect(im).toBeDefined();
    expect(im!.severity).toBe("warning");
    expect(im!.evidence).toContain("3:1");
  });

  it("hotspot_imbalance 不触发：feature=0（小样本保护）或比率未超", async () => {
    const onlyBugfix = [
      commit("b1", 2, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
      commit("b2", 3, "[F20260801tstw][agent][BugFix] 2", ["a.ts"]),
    ];
    expect((await detectSignals(onlyBugfix, [], [], { now: NOW })).find(s => s.type === "hotspot_imbalance"))
      .toBeUndefined();

    const balanced = [
      commit("f1", 1, "[F20260801tstw][agent][New Feature] a", ["a.ts"]),
      commit("f2", 2, "[F20260801tstw][agent][New Feature] b", ["b.ts"]),
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1", ["a.ts"]),
    ];
    expect((await detectSignals(balanced, [], [], { now: NOW })).find(s => s.type === "hotspot_imbalance"))
      .toBeUndefined();
  });

  it("信号结构对齐注册表：name/severity/suggestedAction 来自单一真相源", async () => {
    const commits = [
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/invoker.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/invoker.ts"]),
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/invoker.ts"]),
    ];
    const [rec] = await detectSignals(commits, [], [], { now: NOW });
    expect(rec.name).toBe("bug 反复出现");
    expect(rec.suggestedAction).toBe("强制根因分析");
  });

  it("chain_stall：draft/proposed 文档从未有 commit 不触发（孤儿文档误报修复）", async () => {
    // Why: draft/proposed 文档从未开工是常态，不应触发 critical 信号
    const docs = [{
      id: "F20260801draf", title: "t", changeType: "feature", status: "draft",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    // ChainBuilder 判定为 stalled（>14 天无 commit），但 detectChainStall 应过滤掉
    expect(chains[0].state).toBe("stalled");
    const signals = await detectSignals([], chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
  });

  it("chain_stall：development 文档从未有 commit 仍触发（用 createdAt 计算天数）", async () => {
    // Why: development 状态文档从未有 commit 仍值得关注，但证据应基于 createdAt
    const docs = [{
      id: "F20260801dev0", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/y.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    expect(chains[0].state).toBe("stalled");
    const signals = await detectSignals([], chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.evidence).toContain("40 天"); // 基于 createdAt，不是 "null 天"
  });

  it("hotspot：测试文件不进入热点检测", async () => {
    const testFiles = [
      "tests/api/helpers.ts",
      "tests/usecases/health/detect-signals.test.ts",
      "src/__tests__/foo.ts",
      "src/bar.spec.ts",
    ];
    const commits = Array.from({ length: 12 }, (_, i) =>
      commit(`t${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, [testFiles[i % testFiles.length]]));
    const signals = await detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    expect(signals.find(s => s.type === "hotspot")).toBeUndefined();
  });

  it("hotspot：源码文件仍正常检测（测试文件排除不影响源码）", async () => {
    const commits = [
      ...Array.from({ length: 5 }, (_, i) =>
        commit(`ts${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["tests/foo.test.ts"])),
      ...Array.from({ length: 5 }, (_, i) =>
        commit(`to${i}`, i + 6, `[F20260801tstw][agent][Feature Update] ${i}`, ["src/core.ts"])),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    const hot = signals.find(s => s.type === "hotspot");
    expect(hot).toBeDefined();
    expect(hot!.filePath).toBe("src/core.ts");
  });

  it("chain_stall：design 文档从未有 commit 不触发（design 状态过滤）", async () => {
    // Why: design 文档从未开工是常态（项目规划阶段），不应触发 critical 信号
    const docs = [{
      id: "F20260801desg", title: "t", changeType: "feature", status: "design",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/z.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains([], docs, { now: NOW });
    // ChainBuilder 判定为 stalled（>14 天无 commit），但 detectChainStall 应过滤掉
    expect(chains[0].state).toBe("stalled");
    const signals = await detectSignals([], chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
  });

  it("hotspot：大写 Tests/ 目录也排除（大小写不敏感）", async () => {
    // Why: 某些项目使用大写 Tests/ 目录，应同样排除
    const commits = Array.from({ length: 12 }, (_, i) =>
      commit(`tc${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["Tests/helpers.ts"]));
    const signals = await detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    expect(signals.find(s => s.type === "hotspot")).toBeUndefined();
  });
});

describe("Issue #644：结构化证据 + 置信度", () => {
  it("bug_recurrence 的 detail 含全类型 commit 序列（不只 bugfix，交替节奏可画）", async () => {
    const commits = [
      commit("f1", 10, "[F20260801tstw][agent][New Feature] 引入", ["src/x.ts"]),
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 修1 (#1)", ["src/x.ts"]),
      commit("f2", 6, "[F20260801tstw][agent][Feature Update] 增强", ["src/x.ts"]),
      commit("b2", 4, "[F20260801tstw][agent][BugFix] 修2 (#2)", ["src/x.ts"]),
      commit("b3", 2, "[F20260801tstw][agent][BugFix] 修3 (#3)", ["src/x.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.detail).toBeDefined();
    expect(rec!.detail!.kind).toBe("bug_recurrence_commits");
    // 全类型：3 bugfix + 1 New Feature + 1 Feature Update = 5 个节点（kind 断言后收窄类型）
    const detail = rec!.detail! as import("@usecases/health/detect-signals").SignalDetail;
    expect(detail.commits).toHaveLength(5);
    // 时间升序
    const dates = detail.commits.map(c => c.date);
    expect([...dates].sort()).toEqual(dates);
    // changeType 标注交替（第一个是引入非 bugfix）
    expect(detail.commits[0]!.changeType).toBe("New Feature");
    expect(detail.commits.filter(c => c.changeType === "BugFix")).toHaveLength(3);
  });

  it("detail 窗口滑动整体重算：出窗 commit 不出现在 detail", async () => {
    const commits = [
      commit("old", 45, "[F20260801tstw][agent][BugFix] 出窗", ["src/y.ts"]),
      commit("b1", 8, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/y.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/y.ts"]),
      commit("b3", 3, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/y.ts"]),
    ];
    const signals = await detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    const detail = rec!.detail! as import("@usecases/health/detect-signals").SignalDetail;
    expect(detail.commits).toHaveLength(3);
    expect(detail.commits.every(c => c.sha !== "old")).toBe(true);
  });

  it("chain_stall 置信规则甲：stalled ∧ 有 commit → low；zombie/doc-only → normal", async () => {
    // 滞留但链上有 commit（「干完没归档」主场景）
    const commits = [commit("s1", 20, "[F20260801aaaa][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801aaaa", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = await detectSignals(commits, chains, [], { now: NOW });
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
    const signals2 = await detectSignals([], chains2, [], { now: NOW });
    const stall2 = signals2.find(s => s.type === "chain_stall");
    expect(stall2).toBeDefined();
    expect(stall2!.confidence).toBe("normal");
  });

  it("chain-builder 白名单收编 active：status: active 的滞留链参与病态判定", async () => {
    // Issue #644 止血：41 篇 status:active 文档原先被当终态静默豁免
    const commits = [commit("s1", 20, "[F20260801actv][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801actv", title: "t", changeType: "feature", status: "active",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/a.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    expect(chains[0].state).toBe("stalled"); // 不再豁免
    const signals = await detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.confidence).toBe("low");
  });

  it("置信规则甲 zombie 分支：30 天无 commit 且零提及 → normal（更接近真异常，不降置信）（审视发现 3）", async () => {
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
    const signals = await detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.confidence).toBe("normal"); // zombie 不降置信
    expect(stall!.evidence).toContain("僵尸");
  });
});

describe("Issue #645：behavior_defect 窗口化升级", () => {
  it("窗口内 ≥3 次触发，证据含窗口天数与最近发生日期", async () => {
    const events = [
      healingEvent("w1", "degenerate"),
      healingEvent("w2", "degenerate"),
      healingEvent("w3", "degenerate"),
    ];
    const signals = await detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("窗口 7 天");
    expect(bd!.evidence).toContain("3 次");
    expect(bd!.evidence).toContain("最近一次"); // 聚合含 lastAt
  });

  it("恰在窗口边界：8 天前事件不计数，7 天内 3 次恰触发（含/排除边界）", async () => {
    // 边界定义复刻 bug_recurrence 的 [start, now] 闭区间语义：at >= windowStart 计入
    const justOutside = [
      { ...healingEvent("o1", "tool_failure"), createdAt: dayAgo(8) }, // 窗口外（8 天前）
      healingEvent("i1", "tool_failure"),
      healingEvent("i2", "tool_failure"),
    ];
    const none = await detectSignals([], [], justOutside, { now: NOW });
    expect(none.find(s => s.type === "behavior_defect")).toBeUndefined();

    const justInside = [
      { ...healingEvent("b1", "tool_failure"), createdAt: dayAgo(7) }, // 恰 7 天前：边界含
      healingEvent("b2", "tool_failure"),
      healingEvent("b3", "tool_failure"),
    ];
    const hit = await detectSignals([], [], justInside, { now: NOW });
    const bd = hit.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("3 次");
  });

  it("窗口外历史不再永久累计：12 天前 2 次 + 窗口内 2 次不触发（旧全量聚合会显示 4 次）", async () => {
    const events = [
      { ...healingEvent("h1", "legacy_type"), createdAt: dayAgo(12) },
      { ...healingEvent("h2", "legacy_type"), createdAt: dayAgo(11) },
      healingEvent("h3", "legacy_type"),
      healingEvent("h4", "legacy_type"),
    ];
    const signals = await detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeUndefined(); // 窗口内仅 2 次 < 3
  });

  it("聚合排序：窗口内次数多的 errorType 排在前（聚类优先处置）", async () => {
    const events = [
      healingEvent("a1", "type_a"), healingEvent("a2", "type_a"), healingEvent("a3", "type_a"),
      healingEvent("b1", "type_b"), healingEvent("b2", "type_b"), healingEvent("b3", "type_b"),
      healingEvent("b4", "type_b"), healingEvent("b5", "type_b"),
    ];
    const signals = await detectSignals([], [], events, { now: NOW });
    const bds = signals.filter(s => s.type === "behavior_defect");
    expect(bds).toHaveLength(2);
    expect(bds[0]!.evidence).toContain("type_b"); // 5 次 > 3 次，排前
    expect(bds[1]!.evidence).toContain("type_a");
  });

  it("空窗口不触发（zero-cost 确定性）", async () => {
    const signals = await detectSignals([], [], [], { now: NOW });
    expect(signals.find(s => s.type === "behavior_defect")).toBeUndefined();
  });
});

describe("Issue #645：score_jump 环比骤变", () => {
  type SnapRow = { snapshot_date: string; metric_key: string; metric_value: number };

  function historySource(rows: SnapRow[]) {
    return async () => rows;
  }

  it("单日 |Δ|≥10 触发 warning，detail 含前后两日值", async () => {
    const rows: SnapRow[] = [
      // 前一完整日：整体 80
      { snapshot_date: "2026-08-23", metric_key: "overall", metric_value: 80 },
      { snapshot_date: "2026-08-23", metric_key: "D1", metric_value: 75 },
      // 当日：overall 60（Δ=-20 ≥10 触发）；D1 Δ=-5 不触发
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 60 },
      { snapshot_date: "2026-08-24", metric_key: "D1", metric_value: 70 },
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    const jump = signals.find(s => s.type === "score_jump");
    expect(jump).toBeDefined();
    expect(jump!.severity).toBe("warning");
    expect(jump!.evidence).toContain("2026-08-23→2026-08-24");
    expect(jump!.evidence).toContain("80→60");
    expect(jump!.evidence).not.toContain("75→70"); // 未达阈值的维度不进证据
    // detail 留痕
    const detail = jump!.detail as import("@usecases/health/detect-signals").ScoreJumpDetail;
    expect(detail.kind).toBe("score_jump_snapshots");
    expect(detail.previousValues["overall"]).toBe(80);
    expect(detail.currentValues["overall"]).toBe(60);
  });

  it("上行骤变同样触发（|Δ| 对称：55→70 也报）", async () => {
    const rows: SnapRow[] = [
      { snapshot_date: "2026-08-23", metric_key: "D2", metric_value: 55 },
      { snapshot_date: "2026-08-24", metric_key: "D2", metric_value: 70 },
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    const jump = signals.find(s => s.type === "score_jump");
    expect(jump).toBeDefined();
    expect(jump!.evidence).toContain("+15");
  });

  it("恰在阈值：|Δ|=10 触发（边界含），|Δ|=9.9 不触发", async () => {
    const exact: SnapRow[] = [
      { snapshot_date: "2026-08-23", metric_key: "overall", metric_value: 70 },
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 80 }, // Δ=+10 恰触发
    ];
    const hit = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(exact) });
    expect(hit.find(s => s.type === "score_jump")).toBeDefined();

    const below: SnapRow[] = [
      { snapshot_date: "2026-08-23", metric_key: "overall", metric_value: 70 },
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 79.9 }, // Δ=9.9 不触发
    ];
    const none = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(below) });
    expect(none.find(s => s.type === "score_jump")).toBeUndefined();
  });

  it("不足两个快照日不触发（冷启动）", async () => {
    const rows: SnapRow[] = [
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 80 },
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined();
  });

  it("中间隔无数据日：仍与上一有值日环比（序列缺口不误报为骤变）", async () => {
    const rows: SnapRow[] = [
      { snapshot_date: "2026-08-20", metric_key: "overall", metric_value: 80 },
      // 08-21 ~ 08-23 无数据
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 81 }, // 与 08-20 相比 Δ=1
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined();
  });

  it("缺口填槽（审视发现 1）：日期级缺口且值真骤变时，与上一有值日比较并触发（验证「真的在比较」）", async () => {
    const rows: SnapRow[] = [
      { snapshot_date: "2026-08-20", metric_key: "overall", metric_value: 80 },
      // 08-21 ~ 08-23 无数据：若实现与空日比较则不触发——本用例证明它与 08-20 比较
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 60 }, // 与 08-20 相比 Δ=-20
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    const jump = signals.find(s => s.type === "score_jump");
    expect(jump).toBeDefined();
    // 证据区间直接是 08-20→08-24：证明比较对象是有值的 08-20，不是空日
    expect(jump!.evidence).toContain("2026-08-20→2026-08-24");
    expect(jump!.evidence).toContain("80→60");
    // 锚点即上一有值日：无指标级回溯标注（gapFilledKeys 缺省）
    const detail = jump!.detail as import("@usecases/health/detect-signals").ScoreJumpDetail;
    expect(detail.previousDate).toBe("2026-08-20");
    expect(detail.gapFilledKeys).toBeUndefined();
  });

  it("指标级缺口填槽：锚点日缺该维度行时，回溯到该指标自己的上一有值日", async () => {
    const rows: SnapRow[] = [
      // 信号级锚点日 08-23 有 overall 无 D5（如 D5 无活跃链 null 不落行）
      { snapshot_date: "2026-08-23", metric_key: "overall", metric_value: 78 },
      // D5 的上一有值日在 08-21（08-22、08-23 都缺）
      { snapshot_date: "2026-08-21", metric_key: "D5", metric_value: 75 },
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 79 }, // Δ=1 不触发
      { snapshot_date: "2026-08-24", metric_key: "D5", metric_value: 55 }, // 与 08-21 比 Δ=-20：触发
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    const jump = signals.find(s => s.type === "score_jump");
    expect(jump).toBeDefined();
    expect(jump!.evidence).toContain("D5 75→55");
    expect(jump!.evidence).toContain("基日 2026-08-21 缺口回溯");
    // 未达阈值的维度不进证据（overall Δ=1）
    expect(jump!.evidence).not.toContain("78→79");
    const detail = jump!.detail as import("@usecases/health/detect-signals").ScoreJumpDetail;
    expect(detail.gapFilledKeys?.["D5"]?.previousDate).toBe("2026-08-21");
    // 信号级锚点仍是最近两个有行日（留痕语义不变）
    expect(detail.previousDate).toBe("2026-08-23");
    expect(detail.currentDate).toBe("2026-08-24");
  });

  it("当日缺该维度行：无分子不比，不因锚点日有值就误触发", async () => {
    const rows: SnapRow[] = [
      { snapshot_date: "2026-08-23", metric_key: "D5", metric_value: 80 },
      { snapshot_date: "2026-08-23", metric_key: "overall", metric_value: 78 },
      { snapshot_date: "2026-08-24", metric_key: "overall", metric_value: 79 }, // 当日无 D5 行
    ];
    const signals = await detectSignals([], [], [], { now: NOW, scoreHistorySource: historySource(rows) });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined();
  });

  it("数据源抛异常降级为空（传感器分离，不阻断其余检测）", async () => {
    const signals = await detectSignals([], [], [], {
      now: NOW,
      scoreHistorySource: async () => { throw new Error("db down"); },
    });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined();
  });

  it("数据源异常经 onDetectError 留痕（审视发现 2：不静默吞）", async () => {
    const seen: unknown[] = [];
    const signals = await detectSignals([], [], [], {
      now: NOW,
      scoreHistorySource: async () => { throw new Error("db down"); },
      onDetectError: err => { seen.push(err); },
    });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined(); // 仍降级不阻断
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toBe("db down");
  });

  it("未注入数据源跳过检测（CLI/纯函数场景向后兼容）", async () => {
    const signals = await detectSignals([], [], [], { now: NOW });
    expect(signals.find(s => s.type === "score_jump")).toBeUndefined();
  });
});

describe("Issue #645：僵尸链阶梯（30/60/90）", () => {
  function zombieChain(id: string, lastCommitDaysAgo: number, createdDaysAgo: number) {
    const commits = [commit("zc", lastCommitDaysAgo, `[${id}][agent][New Feature] x`, ["a.ts"])];
    const docs = [{
      id, title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/z.md", createdAt: dayAgo(createdDaysAgo), createdInConversationId: null,
    }];
    const fidMentionCounts = new Map([[id, 0]]); // 提及 Map 显式 0 → zombie 判定成立
    return buildFeatureChains(commits, docs, { now: NOW, fidMentionCounts });
  }

  it("30-59 天 → 黄档；60-89 天 → 红档；≥90 天 → 建议归档", async () => {
    const yellow = await detectSignals([], zombieChain("F20260801zylw", 35, 50), [], { now: NOW });
    expect(yellow.find(s => s.type === "chain_stall")!.evidence).toContain("30 天 黄档");

    const red = await detectSignals([], zombieChain("F20260801zred", 65, 80), [], { now: NOW });
    expect(red.find(s => s.type === "chain_stall")!.evidence).toContain("60 天 红档");

    const archive = await detectSignals([], zombieChain("F20260801zarc", 95, 110), [], { now: NOW });
    expect(archive.find(s => s.type === "chain_stall")!.evidence).toContain("90 天+ 建议归档");
  });

  it("恰在阶梯边界：60 天整为红档（>=），59 天为黄档", async () => {
    const boundary60 = await detectSignals([], zombieChain("F20260801zb60", 60, 75), [], { now: NOW });
    expect(boundary60.find(s => s.type === "chain_stall")!.evidence).toContain("60 天 红档");

    const day59 = await detectSignals([], zombieChain("F20260801zb59", 59, 75), [], { now: NOW });
    expect(day59.find(s => s.type === "chain_stall")!.evidence).toContain("30 天 黄档");
  });

  it("非僵尸滞留（stalled）不带阶梯文案（阶梯只作用于 zombie 态）", async () => {
    const commits = [commit("s1", 20, "[F20260801stg2][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801stg2", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/s.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = await detectSignals(commits, chains, [], { now: NOW });
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.evidence).not.toContain("黄档");
    expect(stall!.evidence).not.toContain("红档");
  });
});
