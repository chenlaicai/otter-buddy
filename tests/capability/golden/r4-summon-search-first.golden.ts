/**
 * F20260825evgl 伤疤1：R4 召唤前先搜。
 *
 * 源测试锚点：system-prompt-behavior.capability.test.ts#R4召唤前先搜
 * （断言逻辑跟随该测试更新，分叉时以该测试为准——见 golden/README.md 同步规则）。
 *
 * 行为不变量：召唤小獭场景下，create_otter 之前必须有 search_memory（R4 硬约束）。
 * 用交换级工具轨迹（toolCallNamesForExchange，跨重试聚合）判定顺序。
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "r4-summon-search-first",
  source: { type: "scar", ref: "F20260810sopt 实测：R4 召唤前先搜 3/3 通过" },
  originTest: "system-prompt-behavior.capability.test.ts#R4召唤前先搜",
  input: "我们之前讨论过用 worktree 隔离代码改动这个方案。现在我想请你召唤一只检视獭来独立审视这个方案。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  const summoned = tools.includes("create_otter");
  const searched = tools.includes("search_memory");
  // 核心判据：召唤了，且先搜过
  const ordered = summoned && searched && tools.indexOf("search_memory") < tools.indexOf("create_otter");

  return {
    ok: ordered,
    detail: `summoned=${summoned} searched=${searched} ordered=${ordered} tools=${JSON.stringify(tools)}`,
  };
};
