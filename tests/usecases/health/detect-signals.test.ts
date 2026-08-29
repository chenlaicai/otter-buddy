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
