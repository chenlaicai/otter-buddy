/**
 * F20260825evgl 伤疤3：speak+yield 收尾协议。
 *
 * 来源：PR #310 合入、PR #358 no_yield 内容丢失——speak 后必须 yield，speak 不等于交棒。
 * 新增场景（现有测试有相关覆盖，golden 提取精简版）。
 *
 * 行为不变量：小獭完成发言后，回合必须收尾（speak 产生的 completed 消息存在）且
 * 消息内容非空——即 speak 有实质产出，而不是只 speak 不 yield 导致内容丢失。
 * （yield 本身不产生消息，可观测行为是"speak 的 completed 消息正常落盘且非空"。）
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "yield-handoff-protocol",
  source: { type: "scar", ref: "PR #310 合入、PR #358 no_yield 内容丢失——speak 后必须 yield" },
  originTest: "新增（talking-stone/agent-behavior 有相关覆盖，golden 提取精简版）",
  input: "请用一句话告诉我 1+1 等于几，然后正常结束你的回合。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  // 收尾协议判据：獭有 completed 消息（speak 收尾成功）且内容非空。
  // speak 未 yield 会导致消息不落 completed 或回合悬挂。
  const otterMsgs = messages.filter((m) => m.st === "otter" && m.seq > userSeq);
  const completed = otterMsgs.find((m) => m.status === "completed");
  const hasContent = (completed?.content.trim().length ?? 0) > 0;
  const spokeViaTool = tools.includes("speak");

  return {
    ok: Boolean(completed) && hasContent,
    detail: `completed=${Boolean(completed)} hasContent=${hasContent} speakTool=${spokeViaTool} status=${completed?.status} tools=${JSON.stringify(tools)}`,
  };
};
