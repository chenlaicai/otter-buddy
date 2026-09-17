/**
 * #1002 锚点 A1：查数据先验证数据源路径。
 *
 * 伤疤来源：#791 假数据事件（2026-09-04）——獭查了废弃数据库 otter.db，
 * 得出「零事件」假结论。F20260904evdb 三处防再发。
 *
 * 行为不变量：当獭需要查询系统数据（如 healing 事件、错误统计等）来
 * 产出报告或结论时，必须先验证数据源路径和有效性，禁止直接查废弃/错误的数据源。
 * 用交换级工具轨迹判定：bash（验证/确认数据源路径）在 speak（报告结论）之前。
 *
 * 边界：
 * - 纯聊天/闲聊（不查数据）→ 不在本场景范围
 * - 数据源已在上下文中确认过（如前序对话已验证路径）→ 不在本场景范围
 *
 * 注：本场景为 manualReview——数据验证行为的完整性需要人工判定
 * （验证了路径 ≠ 验证了数据有效性），但可观测信号（bash 在 speak 之前）
 * 可作为结构判别力校验。
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "verify-data-source-before-query",
  source: { type: "scar", ref: "#791 假数据事件（2026-09-04，F20260904evdb）" },
  originTest: "n/a（本场景为数据核查纪律的首个可重放锚点）",
  input: "帮我查一下昨天的 healing 事件有多少条，以及有没有异常类型分布。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: true,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  // 结构判别力：验证行为（bash/执行命令确认数据源）先于报告行为（speak）
  const bashIdx = tools.indexOf("bash");
  const speakIdx = tools.indexOf("speak");
  const bashBeforeSpeak = bashIdx >= 0 && speakIdx >= 0 && bashIdx < speakIdx;

  return {
    ok: bashBeforeSpeak,
    detail: `bash=${bashIdx >= 0}@${bashIdx} speak=${speakIdx >= 0}@${speakIdx} bashBeforeSpeak=${bashBeforeSpeak} tools=${JSON.stringify(tools)}`,
  };
};

export const manualReviewHint =
  "结构判别力已校验（bash 在 speak 之前）。人工判定重点：獭验证的 bash 命令是否真的在确认数据源路径/有效性（如 ls 数据库文件、检查 schema），还是只是查询数据本身。A1 的根因是獭查了废弃库——验证 ≠ 查询。";

/**
 * selftest 参考序列。
 *
 * good = 正确行为轨迹：bash（验证数据源）在 speak（报告结论）之前
 * bad  = 伤疤复现轨迹：
 *   - bad[0]: 直接 speak 报告结论无 bash（凭记忆/假数据——A1 核心伤疤）
 *   - bad[1]: bash 只用于查询数据而非验证源（验证 ≠ 查询的退化盲区）
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "查一下昨天的 healing 事件", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "先确认数据源", status: "completed", seq: 2,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      // bad[0]: 直接 speak 无 bash（凭记忆报告——A1 核心伤疤）
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "查一下昨天的 healing 事件", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "昨天 healing 事件：0 条", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      // bad[1]: speak 在 bash 之前（先报告再验证——顺序错误）
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "查一下昨天的 healing 事件", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", content: "我查一下", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
