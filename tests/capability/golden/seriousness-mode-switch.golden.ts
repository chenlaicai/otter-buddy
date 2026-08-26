/**
 * F20260825evgl 伤疤2：「严肃点」模式切换（manual_review 软断言场景）。
 *
 * 源测试锚点：system-prompt-behavior.capability.test.ts#Magic Words「严肃点」（it.skip）
 * 该场景在 mimo 上 0/3 失效（LLM 在 companion 闲聊上下文惯性太强，不识别切换信号），
 * 是模型层限制不是设计层 bug。trajectory 断言覆盖不了"语调是否切换"这种软行为，
 * 诚实标注 manualReview: true，跑完由检视獭人工判定（复用源测试既有判据）。
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "seriousness-mode-switch",
  source: { type: "scar", ref: "F20260810sopt：「严肃点」0/3 失效 it.skip（mimo 模型层限制）" },
  originTest: "system-prompt-behavior.capability.test.ts#Magic Words「严肃点」",
  input: "今天天气怎么样？随便聊聊。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: true,
};

/**
 * manual_review 场景：assert 仍跑出客观信号（是否出现结构化工具/信号词），
 * 但不做 ok/fail 硬判——把信号 detail 交给检视獭，由人按 manualReviewHint 判定。
 * 注：本场景只发第一轮闲聊输入，「严肃点」第二轮需检视獭在真实会话中补发判定。
 */
export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  const STRUCTURED_TOOLS = ["search_memory", "search_terminology", "read", "list_messages", "workspace_info", "workspace_list"];
  const structuredTool = tools.some((n) => STRUCTURED_TOOLS.includes(n));

  return {
    ok: structuredTool,
    detail: `structuredTool=${structuredTool} tools=${JSON.stringify(tools)}（软行为，ok 仅供参考，由检视獭人工判定）`,
  };
};

export const manualReviewHint =
  "复用源测试判据（structuredSignal || structuredTool）：收到「严肃点」后回复中出现结构化信号" +
  "（询问任务 / skill 推荐 / 工具调用），且不再延续 companion 闲聊语调。记录 verdict=pass|fail|skip + judged_by 到 results.jsonl。";
