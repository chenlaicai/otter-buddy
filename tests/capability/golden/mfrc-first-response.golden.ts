/**
 * F20260917mfrc 伤疤：首响应原则——新问题第一把工具先看记忆再翻代码。
 *
 * 伤疤来源：2026-09-17 排查（search_query_logs 埋点）：88% invoke 首响应跳过记忆
 * 直接 grep/bash（357 个 invoke 首工具 bash 155/read 112/search_memory 23）。
 *
 * 行为不变量：提出一个项目内有历史脉络的实质问题（非召唤场景）时，
 * 首个检索类工具（search_memory/grep/bash/read 之一）必须是 search_memory。
 * 用交换级工具轨迹（toolCallNamesForExchange）判定。
 *
 * 边界（断言须排除的场景，对应 R4 首响应原则的适用边界）：
 * - 任务匹配既定 skill（A5 优先）→ 不在本场景输入设计内
 * - 纯新话题/闲聊 → 不在本场景输入设计内
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

const RETRIEVAL_TOOLS = ["search_memory", "grep", "bash", "read"];

export const golden: GoldenModule["golden"] = {
  id: "mfrc-first-response",
  source: { type: "scar", ref: "2026-09-17 search_query_logs 排查：88% invoke 首响应跳过记忆（F20260917mfrc）" },
  originTest: "n/a（本场景为首响应原则的首个可重放锚点，尚无对应 capability test）",
  // 项目内有明确历史脉络的问题（worktree 红线是本项目 R1 既有规则），
  // 预期獭先 search_memory 查既有结论，而不是直接 grep 代码找答案
  input: "我想改一下记忆检索的排序逻辑，项目里之前有没有讨论过相关的方案和结论？",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  const firstRetrievalIdx = tools.findIndex((t) => RETRIEVAL_TOOLS.includes(t));
  const firstRetrieval = firstRetrievalIdx >= 0 ? tools[firstRetrievalIdx] : null;
  // 核心判据：首个检索类工具是 search_memory
  const ok = firstRetrieval === "search_memory";

  return {
    ok,
    detail: `firstRetrieval=${firstRetrieval} tools=${JSON.stringify(tools)}`,
  };
};

/**
 * selftest 参考序列。
 *
 * good = 正确行为轨迹：首检索工具是 search_memory（首响应原则合规）
 * bad  = 伤疤复现轨迹：
 *   - bad[0]: 首检索工具是 grep（2026-09-17 目击现场的行为模式）
 *   - bad[1]: 首检索工具是 bash（首工具分布最大头 155/357）
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "项目里之前有没有讨论过记忆检索排序的方案？", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "先搜记忆看既有结论", status: "completed", seq: 2,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "search_memory" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "read" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "项目里之前有没有讨论过记忆检索排序的方案？", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "先 grep 找相关代码", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "grep" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "search_memory" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "项目里之前有没有讨论过记忆检索排序的方案？", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", content: "先用 bash 翻目录", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
