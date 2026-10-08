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
    // #1012 修法 c：三修仅带各自 PR 号、无正文 issue 引用 → 分散形态判 warning
    // （旧断言 critical 是一刀切口径的遗物，新口径下「无共同 issue 主体」= 热点假象）
    expect(rec!.severity).toBe("warning");
    expect(rec!.filePath).toBe("src/invoker.ts");
    expect(rec!.evidence).toContain("agent");
    expect(rec!.evidence).toContain("3 个不同修复事件"); // #1214 新口径：独立 PR 数判据
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
    expect(rec!.evidence).toContain("3 个不同修复事件"); // 计数不被 healing 事件抬高（#1214 口径：独立 PR 数）
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

describe("detectSignals #1214 口径修订（bug_recurrence 同 PR 去重 + 载体排除）", () => {
  // ── #1214 口径修订：同 PR 去重 / 非逻辑载体排除 / occurrences 语义 ──

  it("#1214 同 PR 去重：同 PR 多 commit 只计 1 个修复事件，不再触发（系统性修复不连锁报 7-9 条）", () => {
    const commits = [
      // 同 PR #500 的 3 次链式修复（squash 前多 commit）——旧口径 3 次→触发，新口径 1 事件→不触发
      commit("c1", 3, "[F20260801tstw][agent][BugFix] 1 (#500)", ["src/invoker.ts"]),
      commit("c2", 5, "[F20260801tstw][agent][BugFix] 2 (#500)", ["src/invoker.ts"]),
      commit("c3", 7, "[F20260801tstw][agent][BugFix] 3 (#500)", ["src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("#1214 同 PR 去重：不同 PR 各计 1 次，达阈仍触发；evidence 含独立 PR 清单与首末日期", () => {
    const commits = [
      commit("c1", 3, "[F20260801tstw][agent][BugFix] 1 (#501)", ["src/invoker.ts"]),
      commit("c2", 5, "[F20260801tstw][agent][BugFix] 2 (#501)", ["src/invoker.ts"]),
      commit("c3", 7, "[F20260801tstw][agent][BugFix] 3 (#502)", ["src/invoker.ts"]),
      commit("c4", 9, "[F20260801tstw][agent][BugFix] 4 (#503)", ["src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.evidence).toContain("3 个不同修复事件"); // #501+#502+#503（c2/c3 去重后）
    expect(rec!.evidence).toContain("#501");
    expect(rec!.evidence).toContain("首末修复");
  });

  it("#1214 无 PR 号 commit 按 sha 计事件（本地修复链）", () => {
    const commits = [
      commit("d1", 3, "[F20260801tstw][agent][BugFix] 本地修 1", ["src/invoker.ts"]),
      commit("d2", 5, "[F20260801tstw][agent][BugFix] 本地修 2", ["src/invoker.ts"]),
      commit("d3", 7, "[F20260801tstw][agent][BugFix] 本地修 3", ["src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 检视发现 3：纯无 PR 形态文案不冗余（单短语，不是「无 PR 号 commit + N 个无 PR 号 commit」）
    expect(rec!.evidence).toContain("3 个无 PR 号 commit");
    expect(rec!.evidence).not.toContain("无 PR 号 commit +");
  });

  it("#1214 混合 PR + 无 PR 计数与文案（检视发现 3 补覆盖）", () => {
    const commits = [
      commit("m1", 3, "[F20260801tstw][agent][BugFix] 1 (#801)", ["src/invoker.ts"]),
      commit("m2", 5, "[F20260801tstw][agent][BugFix] 2 (#802)", ["src/invoker.ts"]),
      commit("m3", 7, "[F20260801tstw][agent][BugFix] 本地修", ["src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.evidence).toContain("3 个不同修复事件");
    expect(rec!.evidence).toContain("PR #801, #802 + 1 个无 PR 号 commit");
  });

  it("#1214 载体排除：bootstrap 目录（含其 types.ts）/ index 转发桶 / 组装文件不计（检视发现 6 补三类）", () => {
    const commits = [
      commit("g1", 3, "[F20260801tstw][agent][BugFix] 1 (#811)", ["src/bootstrap/types.ts"]),
      commit("g2", 5, "[F20260801tstw][agent][BugFix] 2 (#812)", ["src/bootstrap/types.ts"]),
      commit("g3", 7, "[F20260801tstw][agent][BugFix] 3 (#813)", ["src/bootstrap/types.ts"]),
      commit("g4", 3, "[F20260801tstw][agent][BugFix] 4 (#814)", ["src/widgets/index.ts"]),
      commit("g5", 5, "[F20260801tstw][agent][BugFix] 5 (#815)", ["src/widgets/index.ts"]),
      commit("g6", 7, "[F20260801tstw][agent][BugFix] 6 (#816)", ["src/widgets/index.ts"]),
      commit("g7", 3, "[F20260801tstw][agent][BugFix] 7 (#817)", ["src/main.ts"]),
      commit("g8", 5, "[F20260801tstw][agent][BugFix] 8 (#818)", ["src/main.ts"]),
      commit("g9", 7, "[F20260801tstw][agent][BugFix] 9 (#819)", ["src/main.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("#1214 载体排除不误伤 runtime 载体 types.ts：非 bootstrap 路径照常计（检视发现 4 回归锚）", () => {
    const commits = [
      commit("h1", 3, "[F20260801tstw][weixin][BugFix] 1 (#821)", ["src/frameworks/weixin/types.ts"]),
      commit("h2", 5, "[F20260801tstw][weixin][BugFix] 2 (#822)", ["src/frameworks/weixin/types.ts"]),
      commit("h3", 7, "[F20260801tstw][weixin][BugFix] 3 (#823)", ["src/frameworks/weixin/types.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined(); // runtime 常量载体（WEIXIN_* 导出）不再被 basename 排除静音
    expect(rec!.filePath).toBe("src/frameworks/weixin/types.ts");
  });

  it("delta D1 回归锚：index.tsx 是页面主组件不是 barrel——不排除照常计（存量信号 5 曾被误静音）", () => {
    const commits = [
      commit("p1", 3, "[F20260801tstw][web][BugFix] 1 (#831)", ["web/src/pages/conversation/index.tsx"]),
      commit("p2", 5, "[F20260801tstw][web][BugFix] 2 (#832)", ["web/src/pages/conversation/index.tsx"]),
      commit("p3", 7, "[F20260801tstw][web][BugFix] 3 (#833)", ["web/src/pages/conversation/index.tsx"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined(); // 页面主组件达阈必须报警
    expect(rec!.filePath).toBe("web/src/pages/conversation/index.tsx");
  });

  it("delta D1 边界：index.ts barrel 照常排除，.mts/.cts 形态同样排除", () => {
    const commits = [
      commit("q1", 3, "[F20260801tstw][web][BugFix] 1 (#841)", ["src/widgets/index.ts"]),
      commit("q2", 5, "[F20260801tstw][web][BugFix] 2 (#842)", ["src/widgets/index.ts"]),
      commit("q3", 7, "[F20260801tstw][web][BugFix] 3 (#843)", ["src/widgets/index.ts"]),
      commit("q4", 3, "[F20260801tstw][web][BugFix] 4 (#844)", ["src/lib/index.mts"]),
      commit("q5", 5, "[F20260801tstw][web][BugFix] 5 (#845)", ["src/lib/index.mts"]),
      commit("q6", 7, "[F20260801tstw][web][BugFix] 6 (#846)", ["src/lib/index.mts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("#1214 非逻辑载体排除：组装文件 / 测试文件不计复发；src 根 types.ts 属装配类型同排除", () => {
    // 注（检视发现 4 处置）：types 规则收窄为「src 根 + bootstrap/」——深层域类型文件
    // （如 agent-turn-orchestrator/types.ts 纯类型、weixin/types.ts runtime 载体）不再
    // 全排除：纯类型域文件不达阈无信号（无害），runtime 载体达阈报警（正确，见 weixin 回归锚）
    const commits = [
      commit("e1", 3, "[F20260801tstw][agent][BugFix] 1 (#601)", ["src/types.ts"]),
      commit("e2", 5, "[F20260801tstw][agent][BugFix] 2 (#602)", ["src/types.ts"]),
      commit("e3", 7, "[F20260801tstw][agent][BugFix] 3 (#603)", ["src/types.ts"]),
      commit("e4", 3, "[F20260801tstw][agent][BugFix] 4 (#604)", ["src/platforms.ts"]),
      commit("e5", 5, "[F20260801tstw][agent][BugFix] 5 (#605)", ["src/platforms.ts"]),
      commit("e6", 7, "[F20260801tstw][agent][BugFix] 6 (#606)", ["src/platforms.ts"]),
      commit("e7", 3, "[F20260801tstw][agent][BugFix] 7 (#607)", ["src/usecases.ts"]),
      commit("e8", 5, "[F20260801tstw][agent][BugFix] 8 (#608)", ["src/usecases.ts"]),
      commit("e9", 7, "[F20260801tstw][agent][BugFix] 9 (#609)", ["src/usecases.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("#1214 混合载体：同批 commit 里逻辑文件仍正常计（排除不误伤）", () => {
    const commits = [
      commit("f1", 3, "[F20260801tstw][agent][BugFix] 1 (#701)", ["src/types.ts", "src/invoker.ts"]),
      commit("f2", 5, "[F20260801tstw][agent][BugFix] 2 (#702)", ["src/types.ts", "src/invoker.ts"]),
      commit("f3", 7, "[F20260801tstw][agent][BugFix] 3 (#703)", ["src/types.ts", "src/invoker.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.filePath).toBe("src/invoker.ts"); // 逻辑文件照常触发
  });
});



describe("detectSignals #1012 修法 c（系列归因分级 + 载体排除补全）", () => {
  // ── 系列归因分级（delta 纠错：锚点从 featureId 换 issue 引用——
  //    本仓 FID↔PR 严格 1:1（全历史实测），FID 判据 critical 分支生产不可达；
  //    issue 引用聚类（#1160 五连 / #1207 集群）是归因报告原案锚点且生产实测存在）──

  it("系列归因：同一 issue 反复修 ≥3 次 → critical（#1160 五连形态，真腐烂）", () => {
    const commits = [
      commit("s1", 3, "[F20260921aaaa][web][BugFix] 右栏根治（#1160） (#1161)", ["web/src/pages/home/index.tsx"]),
      commit("s2", 5, "[F20260923bbbb][web][BugFix] 右栏看门狗（#1160 阶段2） (#1179)", ["web/src/pages/home/index.tsx"]),
      commit("s3", 7, "[F20260928cccc][web][BugFix] 右栏对账（#1160 阶段3） (#1185)", ["web/src/pages/home/index.tsx"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("critical"); // 同 issue 3 修 = 真腐烂
    expect(rec!.evidence).toContain("关联 issue #1160");
  });

  it("系列归因：跨 issue 分散 ≥3 次修复 → warning（热点活跃假象）", () => {
    const commits = [
      commit("d1", 3, "[F20260921aaaa][agent][BugFix] 独立修 1 (#911)", ["src/orchestrator.ts"]),
      commit("d2", 5, "[F20260922bbbb][agent][BugFix] 独立修 2 (#912)", ["src/orchestrator.ts"]),
      commit("d3", 7, "[F20260923cccc][agent][BugFix] 独立修 3 (#913)", ["src/orchestrator.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("warning"); // 无正文 issue 引用，仅各自 PR 号（计数 1，不过 1/3 主体线）= 分散
  });

  it("系列归因：无任何 issue 锚点的本地修复 ≥3 次 → critical（防漏报默认）", () => {
    const commits = [
      commit("n1", 3, "[F20260921aaaa][agent][BugFix] 本地链修 1", ["src/recovery.ts"]),
      commit("n2", 5, "[F20260921aaaa][agent][BugFix] 本地链修 2", ["src/recovery.ts"]),
      commit("n3", 7, "[F20260921aaaa][agent][BugFix] 本地链修 3", ["src/recovery.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("critical"); // 无锚点默认 critical 防漏报
  });

  it("系列归因：混合形态——同 issue 2 修 + 跨 issue 1 修（主体严格过半）→ critical", () => {
    const commits = [
      commit("x1", 3, "[F20260921aaaa][web][BugFix] 右栏修 1（#1160） (#921)", ["web/src/pages/home/index.tsx"]),
      commit("x2", 5, "[F20260922bbbb][web][BugFix] 右栏修 2（#1160） (#922)", ["web/src/pages/home/index.tsx"]),
      commit("x3", 7, "[F20260923cccc][web][BugFix] 独立修（#1150） (#923)", ["web/src/pages/home/index.tsx"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 主体 #1160 计数 2 严格过半（2*2 > 3）→ 同一根因修复系列成立 → critical；
    // 剩余 1 个独立修是系列内噪声，不拖成 warning（判据设计：主体占优即按真腐烂报）
    expect(rec!.severity).toBe("critical");
  });

  // ── 载体排除补全：migration/schema 演进载体 ──

  it("载体排除补全：migration.ts 演进载体不计（N 修 = N 个独立 schema 演进）", () => {
    const commits = [
      commit("m1", 3, "[F20260920aaaa][db][BugFix] 迁移 1 (#931)", ["src/frameworks/db/migration.ts"]),
      commit("m2", 5, "[F20260920bbbb][db][BugFix] 迁移 2 (#932)", ["src/frameworks/db/migration.ts"]),
      commit("m3", 7, "[F20260920cccc][db][BugFix] 迁移 3 (#933)", ["src/frameworks/db/migration.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("载体排除补全：schema.ts 演进载体不计", () => {
    const commits = [
      commit("sc1", 3, "[F20260920aaaa][db][BugFix] schema 1 (#941)", ["src/frameworks/db/schema.ts"]),
      commit("sc2", 5, "[F20260920bbbb][db][BugFix] schema 2 (#942)", ["src/frameworks/db/schema.ts"]),
      commit("sc3", 7, "[F20260920cccc][db][BugFix] schema 3 (#943)", ["src/frameworks/db/schema.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    expect(signals.find(s => s.type === "bug_recurrence")).toBeUndefined();
  });

  it("载体排除补全不误伤：同目录下其他逻辑文件照常计", () => {
    const commits = [
      commit("o1", 3, "[F20260920aaaa][db][BugFix] 连接池 1 (#951)", ["src/frameworks/db/connection-pool.ts"]),
      commit("o2", 5, "[F20260920bbbb][db][BugFix] 连接池 2 (#952)", ["src/frameworks/db/connection-pool.ts"]),
      commit("o3", 7, "[F20260920cccc][db][BugFix] 连接池 3 (#953)", ["src/frameworks/db/connection-pool.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.filePath).toBe("src/frameworks/db/connection-pool.ts");
  });
});

describe("detectSignals 存量信号回放（delta r1 D1 处置：真实生产 message 做测试数据）", () => {
  // 背景：delta r1 发现「测试构造形态 ≠ 生产形态」连续两轮存在——手工构造的理想形态
  // （3 修全引同一 issue）过线，真实数据（集群爆发、每次开新 issue 号）全降 warning。
  // 本组用例把生产真实 message 固化为回归锥，确保判据行为与声明的能力边界一致。
  // 裁决：b 路线——机械判据对集群爆发形态判 warning，靠专项 issue 兜底（#1260 宪法在途），
  // 知情声明落在特性文档 intent 与 PR body。

  it("【回放】bash 守卫集群爆发形态（21 修 28 个号全计数 1）→ warning（能力边界如实）", () => {
    // 生产真实形态捕样：bash-safety-guard.ts 30 天窗 21 修，issue/PR 号各不相同（#777→#850→#984→#1120→…）
    // 抽 3 条代表性 message（最小可判样本）：每次修复开新 issue 号 + 各自 PR 号，主体计数全 1
    const commits = [
      commit("rb1", 3, "[F20260916xxxx][guard][BugFix] 守卫修 1：误拦收口 (#777) (#990)", ["src/frameworks/agent/bash-safety-guard.ts"]),
      commit("rb2", 5, "[F20260923yyyy][guard][BugFix] 守卫修 2：heredoc 判定 (#984) (#1120)", ["src/frameworks/agent/bash-safety-guard.ts"]),
      commit("rb3", 7, "[F20260930zzzz][guard][BugFix] 守卫修 3：体感知拦 (#1207) (#1239)", ["src/frameworks/agent/bash-safety-guard.ts"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 每号计数 1，主体不过半（1*2 > 3 不成立）→ warning。这是声明的能力边界：
    // 集群爆发形态（真腐烂）靠专项 issue 兜底（#1260 守卫宪法），机械判据不试图覆盖
    expect(rec!.severity).toBe("warning");
  });

  it("【单元】#1160 系列目标形态（正文引用同 issue 严格过半）→ critical（判据单元验证）", () => {
    // 判据目标形态的单元验证（非生产全量——生产 index.tsx 30 天窗 12 BugFix、#1160 计 3、
    // 6≤12 不过半判 warning，见下一用例【回放】稀释形态）。此处验证判据在过半时的行为
    const commits = [
      commit("rc1", 3, "[F20260921aaaa][web][BugFix] 右栏根治（#1160） (#1161)", ["web/src/pages/home/index.tsx"]),
      commit("rc2", 5, "[F20260923bbbb][web][BugFix] 右栏看门狗（#1160 阶段2） (#1179)", ["web/src/pages/home/index.tsx"]),
      commit("rc3", 7, "[F20260928cccc][web][BugFix] 右栏对账（#1160 阶段3） (#1185)", ["web/src/pages/home/index.tsx"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe("critical");
  });

  it("【单元】混合形态：主体 #1160 计 3/4 修（严格过半）→ critical（判据单元验证）", () => {
    // 判据目标形态的单元验证：3×2>4 严格过半 → critical。
    // ⚠ 原注释「index.tsx 10 修计 3 主体占优仍过线」与生产判定相反（6≤10 判 warning）——
    // 检视 r3 严重 1 指出集合截断致判定翻转，生产全量断言见下一用例
    const commits = [
      commit("rh1", 3, "[F20260921aaaa][web][BugFix] 右栏根治（#1160） (#1161)", ["web/src/pages/conversation/index.tsx"]),
      commit("rh2", 5, "[F20260923bbbb][web][BugFix] 右栏看门狗（#1160 阶段2） (#1179)", ["web/src/pages/conversation/index.tsx"]),
      commit("rh3", 7, "[F20260928cccc][web][BugFix] 右栏对账（#1160 阶段3） (#1185)", ["web/src/pages/conversation/index.tsx"]),
      commit("rh4", 9, "[F20260930dddd][web][BugFix] 独立修（#1150） (#1159)", ["web/src/pages/conversation/index.tsx"]),
    ];
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 3*2 > 4 严格过半 → critical（判据单元验证；生产稀释形态见下）
    expect(rec!.severity).toBe("critical");
  });

  it("【回放】index.tsx 全量稀释形态（30 天窗 12 BugFix、#1160 计 3、6≤12 不过半）→ warning（能力边界如实）", () => {
    // 生产全量回放（检视 r3 严重 1 处置）：活跃热点文件的真系列被同期其他修复稀释——
    // git log 实测 12 个 BugFix 唯一 PR 号（#1292/#1268/#1251/#1185/#1179/#1161/#1095/#1076/#1072/#993/#963/#922 等），
    // #1160 正文引用计 3，3*2=6 ≤ 12 不过半 → warning。
    // 这是能力边界的第二种失效机制（第一种：集群爆发全计数 1）——严格过半线在活跃文件上不可达
    const prMessages: Array<[string, string]> = [
      ["d1", "[F20260924ircc][web][BugFix] 右栏状态回归根治：分离防双拉门控与断连重连补偿语义（#1160） (#1161)"],
      ["d2", "[F20260928icmm][web][BugFix] 右栏状态缓存模型换轨：弱合并退役，对账可覆盖本地（#1160 根治·阶段1） (#1179)"],
      ["d3", "[F20260928audt][web][BugFix] 右栏长尾兜底：60s 周期对账（#1160 阶段2） (#1185)"],
      ["d4", "[F20261001mmmq][web][BugFix] 独立修 A (#1268)"],
      ["d5", "[F20261001nnnp][web][BugFix] 独立修 B (#1251)"],
      ["d6", "[F20260930oooz][web][BugFix] 独立修 C (#1095)"],
      ["d7", "[F20260929pppa][web][BugFix] 独立修 D (#1076)"],
      ["d8", "[F20260929qqqs][web][BugFix] 独立修 E (#1072)"],
      ["d9", "[F20260926rrrt][web][BugFix] 独立修 F (#993)"],
      ["d10", "[F20260925sssv][web][BugFix] 独立修 G (#963)"],
      ["d11", "[F20260924tttx][web][BugFix] 独立修 H (#922)"],
      ["d12", "[F20261005uuuk][web][BugFix] 独立修 I (#1292)"],
    ];
    const commits = prMessages.map(([sha, msg], i) => commit(sha, 3 + i, msg, ["web/src/pages/conversation/index.tsx"]));
    const signals = detectSignals(commits, [], [], { now: NOW });
    const rec = signals.find(s => s.type === "bug_recurrence");
    expect(rec).toBeDefined();
    // 全量集合下 #1160 计 3、events=12，3*2=6 ≤ 12 → warning：真系列被稀释，
    // 与生产判定一致（r1 id 5 / r3 独立复算双源）
    expect(rec!.severity).toBe("warning");
  });
});
