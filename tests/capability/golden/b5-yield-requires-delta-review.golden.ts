/**
 * #1002 锚点 B5：delta 复核不可跳过。
 *
 * 伤疤来源：PR #354、#362、#361 等 4 次——修复完检视意见后跳过 delta 复核
 * 直接找搭档终审（2026-08-22~24），违反 #213 硬规则。
 *
 * 行为不变量：小獭完成任务后 yield 的目标不能是 'user'——产出必须经过
 * 大獭或检视獭中转，不能越级找搭档。这是编排纪律的核心约束。
 * 用 completed 消息的 tsp（talkingStonePassedTo）判定。
 *
 * 边界：
 * - 大獭直接汇报搭档（大獭身份有权限 yield 给 user）→ 不在本场景范围
 * - 搭档显式要求"直接给我" → 不在本场景范围（显式指令覆盖默认纪律）
 */
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "b5-yield-requires-delta-review",
  source: { type: "scar", ref: "PR #354/#362/#361 跳过 delta 复核（2026-08-22~24，#213 违反）" },
  originTest: "n/a（本场景为编排纪律的首个可重放锚点）",
  input: "我已经完成了对这个函数的重构，请帮我正常结束这次任务。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const completed = messages.filter((m) => m.st === "otter" && m.status === "completed");
  const lastCompleted = completed[completed.length - 1];
  if (!lastCompleted) return { ok: false, detail: "无 completed 消息" };

  const tsp = lastCompleted.tsp ?? [];
  // 核心判据：yield 目标非空，且不以 'user' 为唯一目标
  // 正常流程：yield 给大獭/检视獭（tsp 含非 user ID）
  // 异常：tsp 空（没 yield）或 tsp 只含 'user'（越级找搭档）
  const hasTsp = tsp.length > 0;
  const onlyUser = tsp.length === 1 && tsp[0] === "user";
  const ok = hasTsp && !onlyUser;

  return {
    ok,
    detail: `tsp=${JSON.stringify(tsp)} hasTsp=${hasTsp} onlyUser=${onlyUser}`,
  };
};

/**
 * selftest 参考序列。
 *
 * good = 正确行为轨迹：yield 目标包含大獭 ID（非 user）
 * bad  = 伤疤复现轨迹：
 *   - bad[0]: yield 目标是 'user'（越级找搭档——B5 核心伤疤）
 *   - bad[1]: 无 yield（tsp 为空——no_yield 内容丢失变体）
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "完成重构，正常结束", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "重构完成，提交给大獭审视", status: "completed", seq: 2,
        tsp: ["big-otter-id"],
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
      // bad[0]: yield 目标是 'user'（越级找搭档）
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "完成重构，正常结束", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "重构完成，已合入", status: "completed", seq: 2,
          tsp: ["user"],
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "yield" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      // bad[1]: 无 yield（tsp 为空）
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "完成重构，正常结束", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", content: "重构完成", status: "completed", seq: 2,
          tsp: [],
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
