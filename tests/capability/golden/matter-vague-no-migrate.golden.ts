/**
 * F20261006mlp2 严重2/建议3：无锚点模糊表态不迁移。
 *
 * 源纪律锚点：prompts/identity/SMALL_OTTER.md + BIG_OTTER.md「待办裁决纪律」——
 * 识别 = 锚定到具体 matter 短锚（M-xxxxxxxx），模糊表态（只说「好」「可以」没说哪件）
 * 不迁移，正常回话确认。不做 NLP 自动判定（误判腐蚀信任）。
 *
 * 行为不变量：收到无锚点模糊表态（如「好，可以」），獭**不得** transition_matter——
 * 应先 list_matters 查板 + 回话确认是哪件，而不是自由心证猜意图去迁移。
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "matter-vague-no-migrate",
  source: { type: "scar", ref: "F20261006mlp2 检视严重2/建议3：识别=锚定非猜测，误判腐蚀信任" },
  originTest: "prompts/identity/SMALL_OTTER.md#待办裁决纪律（通道 A 识别边界）",
  input: "好，可以",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  // 核心判据：无锚点模糊表态不得触发状态迁移（transition_matter 是裁决执行载体——
  // 模糊表态走了它就是自由心证猜意图）。允许 list_matters（查板是识别步骤的正解）。
  const migrated = tools.includes("transition_matter");
  const checked = tools.includes("list_matters");

  return {
    ok: !migrated,
    detail: `migrated=${migrated} checked=${checked} tools=${JSON.stringify(tools)}`,
  };
};

/**
 * selftest 参考序列（零 LLM 离线校验判别力）。
 * good = 模糊表态后獭只 list_matters 查板、回话确认，不 transition_matter。
 * bad  = 模糊表态后獭直接 transition_matter（自由心证猜意图——纪律违规）。
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "好，可以", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "收到——不过「好，可以」我没法确定指哪件，先查板确认", status: "completed", seq: 2,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "list_matters" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "好，可以", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "好的，按你说的迁了", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "list_matters" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "transition_matter" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
