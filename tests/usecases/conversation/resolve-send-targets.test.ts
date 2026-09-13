/**
 * resolveDefaultTargets 优先级测试（F20260913ctlv test12：steer 目标解析优先 running 獭）。
 *
 * 搭档拍板优先级：
 * 1. 当前 running 的獭（单只 → 选它；多只 → 用户发言前最新一次 speak 的那只）
 * 2. 无 running → 最后完成发言的獭
 * 3. 兜底在场大獭
 *
 * 经 resolveSendTargets（explicit 空 + body 无 @）走默认派发链路验证。
 */
import { describe, it, expect } from "vitest";
import { resolveSendTargets, type ResolveTargetsDeps } from "@usecases/conversation/resolve-send-targets";
import type { Logger } from "@usecases/ports/logger";

const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

interface DepsSpec {
  participants?: string[];
  otters?: Record<string, { name: string; type: string; status: string }>;
  recentSpeakSenders?: Array<string | null>;
  running?: string[];
}

function makeDeps(spec: DepsSpec): ResolveTargetsDeps {
  return {
    getActiveParticipants: async () => (spec.participants ?? []).map(otterId => ({ otterId })),
    getLastSpeakEntry: async () => {
      const s = spec.recentSpeakSenders?.find(x => x) ?? null;
      return s ? { senderId: s } : null;
    },
    getRecentSpeakSenders: async () => spec.recentSpeakSenders ?? [],
    getOtterById: async (id: string) => {
      const o = spec.otters?.[id];
      return o ? { id, ...o } : null;
    },
    getRunningOtterIds: async () => spec.running ?? [],
  };
}

describe("resolveDefaultTargets：running 优先（test12 案发现场回归）", () => {
  it("单只 running → 选它（steer 进话獭，不再错选大獭）", async () => {
    // test12 场景：话獭 running、最后完成 speak 的是大獭——旧逻辑选大獭（bug），新逻辑选话獭
    const deps = makeDeps({
      participants: ["big-1", "talk-1"],
      otters: {
        "big-1": { name: "大獭", type: "big", status: "active" },
        "talk-1": { name: "话獭", type: "small", status: "active" },
      },
      recentSpeakSenders: ["big-1", "big-1", "talk-1"],
      running: ["talk-1"],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "哎，你们停下吧" });
    expect(r.targets).toEqual(["talk-1"]);
  });

  it("多只 running → 选发言前最新一次 speak 属于 running 集合的那只", async () => {
    // 两只 running（话獭/图獭），最近 speak 序：大獭(不在 running) → 图獭 → 话獭 → 选图獭
    const deps = makeDeps({
      participants: ["big-1", "talk-1", "image-1"],
      otters: {
        "big-1": { name: "大獭", type: "big", status: "active" },
        "talk-1": { name: "话獭", type: "small", status: "active" },
        "image-1": { name: "图獭", type: "small", status: "active" },
      },
      recentSpeakSenders: ["big-1", "image-1", "talk-1"],
      running: ["talk-1", "image-1"],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "你们看下进度" });
    expect(r.targets).toEqual(["image-1"]);
  });

  it("多只 running 且集合内无 speak 记录 → 取首只（同时开工无发言，无从比较）", async () => {
    const deps = makeDeps({
      participants: ["a-1", "b-1"],
      otters: {
        "a-1": { name: "甲", type: "small", status: "active" },
        "b-1": { name: "乙", type: "small", status: "active" },
      },
      recentSpeakSenders: ["big-1"],
      running: ["a-1", "b-1"],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "进度如何" });
    expect(r.targets).toEqual(["a-1"]);
  });

  it("无 running → 回退最后完成发言的獭（旧逻辑保持）", async () => {
    const deps = makeDeps({
      participants: ["big-1", "talk-1"],
      otters: {
        "big-1": { name: "大獭", type: "big", status: "active" },
        "talk-1": { name: "话獭", type: "small", status: "active" },
      },
      recentSpeakSenders: ["talk-1", "big-1"],
      running: [],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "在吗" });
    expect(r.targets).toEqual(["talk-1"]);
  });

  it("running 獭已退场/解散 → 过滤后回退最后发言獭", async () => {
    const deps = makeDeps({
      participants: ["big-1", "talk-1"], // running 獭 ghost-1 不在参与者名册
      otters: {
        "big-1": { name: "大獭", type: "big", status: "active" },
        "talk-1": { name: "话獭", type: "small", status: "active" },
        "ghost-1": { name: "幽灵", type: "small", status: "dissolved" },
      },
      recentSpeakSenders: ["talk-1"],
      running: ["ghost-1"],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "在吗" });
    expect(r.targets).toEqual(["talk-1"]);
  });

  it("无 running 无 speak → 兜底在场大獭", async () => {
    const deps = makeDeps({
      participants: ["big-1"],
      otters: { "big-1": { name: "大獭", type: "big", status: "active" } },
      recentSpeakSenders: [],
      running: [],
    });
    const r = await resolveSendTargets({ deps, logger, conversationId: "conv-1", explicit: [], body: "在吗" });
    expect(r.targets).toEqual(["big-1"]);
  });
});
