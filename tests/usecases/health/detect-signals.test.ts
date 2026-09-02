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

  it("chain_stall：pr-stalled 信号触发 critical（F20260902sigm：读 chain.signals）", () => {
    const commits = [commit("s1", 3, "[F20260801aaaa][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801aaaa", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/x.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const openPrs = [{
      number: 42, title: "PR", headRefName: "feature/x", body: null,
      url: "https://example.com/pr/42", createdAt: dayAgo(30),
      lastActivityAt: dayAgo(20), featureIds: ["F20260801aaaa"],
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW, openPrs });
    const signals = detectSignals(commits, chains, [], { now: NOW });

    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.severity).toBe("critical");
    expect(stall!.featureId).toBe("F20260801aaaa");
    expect(stall!.evidence).toContain("#42");
    expect(stall!.evidence).toContain("20 天无推进");
    // pr-stalled 是 PR 事实而非猜测，不降置信
    expect(stall!.confidence).toBe("normal");
  });

  it("chain_stall 不触发：commit 静默但无 open PR（旧 stalled 语义删除）", () => {
    const commits = [commit("s1", 45, "[F20260801nnnn][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801nnnn", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/n.md", createdAt: dayAgo(50), createdInConversationId: null,
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW });
    const signals = detectSignals(commits, chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
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
    for (const cm of rec!.detail!.commits) {
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

  it("F20260902sigm：doc-only 链（任何 status，无论创建多久）零信号——零 commit 是常态不是病", () => {
    // 旧模型按 status 过滤（draft/proposed/design 豁免、development 触发）；新模型 docStatus 退役，
    // doc-only 一律稳定（245 篇零 commit 文档是本仓常态，方案 R6）
    const docs = [
      { id: "F20260801draf", title: "t", changeType: "feature", status: "draft",
        tags: [], modules: [], causalLinksFrom: [], supersedes: [],
        filePath: "docs/features/x1.md", createdAt: dayAgo(40), createdInConversationId: null },
      { id: "F20260801dev0", title: "t", changeType: "feature", status: "development",
        tags: [], modules: [], causalLinksFrom: [], supersedes: [],
        filePath: "docs/features/x2.md", createdAt: dayAgo(40), createdInConversationId: null },
      { id: "F20260801desg", title: "t", changeType: "feature", status: "design",
        tags: [], modules: [], causalLinksFrom: [], supersedes: [],
        filePath: "docs/features/x3.md", createdAt: dayAgo(90), createdInConversationId: null },
    ];
    const chains = buildFeatureChains([], docs, { now: NOW });
    for (const c of chains) {
      expect(c.state).toBe("active");
      expect(c.signals).toEqual([]);
    }
    const signals = detectSignals([], chains, [], { now: NOW });
    expect(signals.find(s => s.type === "chain_stall")).toBeUndefined();
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

  it("hotspot：大写 Tests/ 目录也排除（大小写不敏感）", () => {
    // Why: 某些项目使用大写 Tests/ 目录，应同样排除
    const commits = Array.from({ length: 12 }, (_, i) =>
      commit(`tc${i}`, i + 1, `[F20260801tstw][agent][Feature Update] ${i}`, ["Tests/helpers.ts"]));
    const signals = detectSignals(commits, [], [], { now: NOW, hotspotThreshold: 3 });
    expect(signals.find(s => s.type === "hotspot")).toBeUndefined();
  });
});

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
    expect(rec!.detail!.commits).toHaveLength(5);
    // 时间升序
    const dates = rec!.detail!.commits.map(c => c.date);
    expect([...dates].sort()).toEqual(dates);
    // changeType 标注交替（第一个是引入非 bugfix）
    expect(rec!.detail!.commits[0]!.changeType).toBe("New Feature");
    expect(rec!.detail!.commits.filter(c => c.changeType === "BugFix")).toHaveLength(3);
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
    expect(rec!.detail!.commits).toHaveLength(3);
    expect(rec!.detail!.commits.every(c => c.sha !== "old")).toBe(true);
  });

  it("F20260902sigm：多停滞 PR 逐条出信号（挂几个报几个）", () => {
    const commits = [commit("s1", 3, "[F20260801mult][agent][New Feature] x", ["a.ts"])];
    const docs = [{
      id: "F20260801mult", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/m.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const mkPr = (n: number, days: number) => ({
      number: n, title: `PR ${n}`, headRefName: "feature/x", body: null,
      url: `https://example.com/pr/${n}`, createdAt: dayAgo(days + 5),
      lastActivityAt: dayAgo(days), featureIds: ["F20260801mult"],
    });
    const chains = buildFeatureChains(commits, docs, { now: NOW, openPrs: [mkPr(51, 20), mkPr(52, 9)] });
    const signals = detectSignals(commits, chains, [], { now: NOW });
    const stalls = signals.filter(s => s.type === "chain_stall");
    expect(stalls).toHaveLength(2);
    expect(stalls.map(s => s.evidence)).toContainEqual(expect.stringContaining("#51"));
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

describe("Issue #660：behavior_defect 窗口边界覆盖增强", () => {
  // 语义锚点（与 issue 文本的口径差异留痕）：issue #660 第三项「降序（聚类优先）」源自
  // PR #656（未合入实现）的「信号按窗口内次数降序」；main 合入的 #658 实际语义是
  // 「同型事件按 createdAt 升序聚合，evidence 报最早~最晚」（F20260901rhdet §② 明文），
  // 无跨类型密度排序。本组用例锁定 #658 合入版契约，密度排序属特性变更不在本 issue 范围。

  it("混合时间分布：12 天前×2 与窗口内×3 交错 → 只计窗口内 3 次触发", () => {
    // Why 交错：现有用例的窗口外事件是成组排列的，未覆盖乱序输入下窗口过滤的正确性
    const events = [
      healingEvent("a", "tool_failure", 12), // 窗口外
      healingEvent("b", "tool_failure", 1),  // 窗口内（最晚）
      healingEvent("c", "tool_failure", 12), // 窗口外
      healingEvent("d", "tool_failure", 3),  // 窗口内
      healingEvent("e", "tool_failure", 6),  // 窗口内（最早）
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("7 天内复发 3 次"); // 窗口外 2 次不抬计数（全计入则 5 次）
    expect(bd!.evidence).not.toContain("5 次");
    // 日期范围只含窗口内最早~最晚；窗口外日期（12 天前）不出现
    expect(bd!.evidence).toContain(`${dayAgo(6).slice(0, 10)} ~ ${dayAgo(1).slice(0, 10)}`);
    expect(bd!.evidence).not.toContain(dayAgo(12).slice(0, 10));
  });

  it("混合时间分布（负例）：窗口外交错 + 窗口内仅 2 次 → 不触发", () => {
    // 全量 4 次超阈值，但交错分布下窗口内只有 2 次——窗口化对乱序输入同样成立
    const events = [
      healingEvent("a", "degenerate", 12),
      healingEvent("b", "degenerate", 1),
      healingEvent("c", "degenerate", 12),
      healingEvent("d", "degenerate", 5),
    ];
    expect(detectSignals([], [], events, { now: NOW }).find(s => s.type === "behavior_defect"))
      .toBeUndefined();
  });

  it("多 errorType 交错独立计数：各型均不足 → 不触发；各型均足 → 两条独立信号", () => {
    // 负例：三型交错各有 1-2 次，任何一型都不该触发；若跨型合并会计 5 次 → 误报
    const mixed = [
      healingEvent("a", "tool_failure", 1),
      healingEvent("b", "degenerate", 2),
      healingEvent("c", "circuit_break", 3),
      healingEvent("d", "tool_failure", 5),
      healingEvent("e", "degenerate", 6),
    ];
    expect(detectSignals([], [], mixed, { now: NOW }).find(s => s.type === "behavior_defect"))
      .toBeUndefined();

    // 正例：两型各自 ≥3 次且时间交错 → 两条信号独立触发，互不合并也不互抬计数
    const both = [
      healingEvent("x1", "degenerate", 1),
      healingEvent("x2", "degenerate", 2),
      healingEvent("x3", "degenerate", 3),
      healingEvent("y1", "circuit_break", 1),
      healingEvent("y2", "circuit_break", 4),
      healingEvent("y3", "circuit_break", 6),
    ];
    const bds = detectSignals([], [], both, { now: NOW }).filter(s => s.type === "behavior_defect");
    expect(bds).toHaveLength(2);
    expect(bds.every(s => s.evidence.includes("复发 3 次"))).toBe(true); // 不互抬
    expect(bds.some(s => s.evidence.includes("degenerate"))).toBe(true);
    expect(bds.some(s => s.evidence.includes("circuit_break"))).toBe(true);
  });

  it("多信号类型共存互不干扰：bug_recurrence + chain_stall + behavior_defect 同场各自触发", () => {
    const commits = [
      commit("s1", 3, "[F20260801mx66][agent][New Feature] x", ["src/stall.ts"]),
      commit("b1", 3, "[F20260801tstw][agent][BugFix] 1 (#1)", ["src/invoker.ts"]),
      commit("b2", 6, "[F20260801tstw][agent][BugFix] 2 (#2)", ["src/invoker.ts"]),
      commit("b3", 9, "[F20260801tstw][agent][BugFix] 3 (#3)", ["src/invoker.ts"]),
    ];
    const docs = [{
      id: "F20260801mx66", title: "t", changeType: "feature", status: "development",
      tags: [], modules: [], causalLinksFrom: [], supersedes: [],
      filePath: "docs/features/mx66.md", createdAt: dayAgo(40), createdInConversationId: null,
    }];
    const openPrs = [{
      number: 88, title: "PR", headRefName: "feature/mx66", body: null,
      url: null, createdAt: dayAgo(30), lastActivityAt: dayAgo(12), featureIds: ["F20260801mx66"],
    }];
    const chains = buildFeatureChains(commits, docs, { now: NOW, openPrs });
    const events = [
      healingEvent("h1", "tool_failure", 5),
      healingEvent("h2", "tool_failure", 3),
      healingEvent("h3", "tool_failure", 1),
    ];
    const signals = detectSignals(commits, chains, events, { now: NOW });

    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.evidence).toContain("3 次"); // 计数不被 healing 事件抬高
    const stall = signals.find(s => s.type === "chain_stall");
    expect(stall).toBeDefined();
    expect(stall!.featureId).toBe("F20260801mx66"); // 判定不被 healing/commit 混入干扰
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("3 次"); // 计数不被 commit 抬高
  });

  it("聚合按时间升序（#658 合入版契约）：新→旧乱序输入 → evidence 范围为窗口内最早~最晚", () => {
    // Why：既有「聚合按时间排序」用例的输入恰好是旧→新顺序，不排序也能通过——
    // 本用例用新→旧乱序输入真正锁定排序行为（乱序时 first/last 会取错端点）
    const events = [
      healingEvent("new", "degenerate", 0.5),  // 窗口内最晚
      healingEvent("mid", "degenerate", 3),
      healingEvent("old", "degenerate", 6),    // 窗口内最早
      healingEvent("far", "degenerate", 12),   // 窗口外
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    const earliest = dayAgo(6).slice(0, 10);
    const latest = dayAgo(0.5).slice(0, 10);
    // 升序契约：范围端点 = 最早在前、最晚在后；按输入顺序（新→旧）聚合会反向
    expect(bd!.evidence.indexOf(earliest)).toBeLessThan(bd!.evidence.indexOf(latest));
    expect(bd!.evidence).not.toContain(dayAgo(12).slice(0, 10)); // 窗口外不进范围
  });

  it("7 天窗口恰含边界：窗口起点同刻事件计入（>= 语义，degenerate 型）", () => {
    const boundary = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = [
      { ...healingEvent("b0", "degenerate"), createdAt: boundary }, // 恰在窗口起点
      healingEvent("b1", "degenerate", 2),
      healingEvent("b2", "degenerate", 4),
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    expect(bd!.evidence).toContain("复发 3 次"); // 边界点计入（排除则仅 2 次不触发）
  });

  it("7 天窗口恰排除边界：窗口起点 -1ms 不计入（circuit_break 型）", () => {
    const justOut = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000 - 1).toISOString();
    const events = [
      { ...healingEvent("j0", "circuit_break"), createdAt: justOut }, // 恰在窗口起点之前 1ms
      healingEvent("j1", "circuit_break", 2),
      healingEvent("j2", "circuit_break", 4),
      healingEvent("j3", "circuit_break", 5),
    ];
    const signals = detectSignals([], [], events, { now: NOW });
    const bd = signals.find(s => s.type === "behavior_defect");
    expect(bd).toBeDefined();
    // 窗口内 3 次触发，恰排除事件不计入（计入则 4 次）
    expect(bd!.evidence).toContain("复发 3 次");
    expect(bd!.evidence).not.toContain("4 次");
  });
});
