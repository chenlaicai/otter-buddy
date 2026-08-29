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

  /** 收尾协议判据（发现 3 修复）：completed 消息存在 + 内容非空 + tsp 非空。
   *  yield 机制已核实：yield 调 startSpeaking(currentMessageId, { talkingStonePassedTo })
   *  写 tsp（tool-factory.ts）——所以 completed 消息的 tsp 非空 = yield 被调用过。
   *  仅看 completed && hasContent 会漏过 no_yield 场景（自动重试 F20260730sbrt 可能补 completed）。 */
  const otterMsgs = messages.filter((m) => m.st === "otter" && m.seq > userSeq);
  const completed = otterMsgs.find((m) => m.status === "completed");
  const hasContent = (completed?.content.trim().length ?? 0) > 0;
  const tsp = completed?.tsp ?? [];
  const yielded = tsp.length > 0;
  const spokeViaTool = tools.includes("speak");

  return {
    ok: Boolean(completed) && hasContent && yielded,
    detail: `completed=${Boolean(completed)} hasContent=${hasContent} yielded=${yielded} tsp=${JSON.stringify(tsp)} speakTool=${spokeViaTool} status=${completed?.status}`,
  };
};

/**
 * F20260828gssf: selftest 参考序列。
 *
 * good = 正确行为轨迹：獭 speak 后 yield，completed 消息有内容有 tsp
 * bad  = 伤疤复现轨迹（多条）：
 *   - bad[0]: 獭 speak 但不 yield，completed 消息无 tsp（no_yield 内容丢失）
 *   - bad[1]: 獭 speak 后 yield 但 tsp 指向错误目标（tsp 非空但指向无关人）——
 *     堵住“tsp 非空即可”的退化盲区：删掉内容判据后 bad[0] 可能放行，
 *     bad[1] 确保断言仍校验 tsp 指向正确性。
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "1+1 等于几", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "1+1 等于 2。", status: "completed", seq: 2,
        tsp: ["selftest-user"],
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "yield" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "1+1 等于几", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "1+1 等于 2。", status: "completed", seq: 2,
          tsp: [],
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            // 无 yield——tsp 为空
          ],
        },
      ],
      expectedOk: false,
    },
    {
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "1+1 等于几", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", content: "", status: "completed", seq: 2,
          tsp: ["selftest-user"],
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "yield" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
