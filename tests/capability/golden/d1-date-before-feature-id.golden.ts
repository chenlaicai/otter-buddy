/**
 * #1002 锚点 D1：生成特性 ID 前必须跑 date。
 *
 * 伤疤来源：F20260916rgsv 编号错误（2026-09-17）——跨零点没重跑 date，
 * 特性 ID 用了昨天的日期，全仓改名修正。#422 型错误复发。
 *
 * 行为不变量：当獭要创建特性文档或生成特性 ID 时，必须先调用 bash/date
 * 获取当前日期，禁止凭记忆标日期。
 * 用交换级工具轨迹（toolCallNamesForExchange）判定：bash(date) 先于 write/edit。
 *
 * 边界：
 * - 纯读取/查询操作（不创建新特性文档）→ 不在本场景范围
 * - 搭档提供了显式日期 → 不在本场景范围（显式指令覆盖默认纪律）
 */
import { toolCallNamesForExchange, latestUserSeq } from "../helpers/assert-behavior";
import type { GoldenModule } from "./golden.runner";

export const golden: GoldenModule["golden"] = {
  id: "date-before-feature-id",
  source: { type: "scar", ref: "F20260916rgsv 编号错误（2026-09-17，#422 复发）" },
  originTest: "n/a（本场景为日期纪律的首个可重放锚点）",
  input: "请帮我为这个新功能创建一个特性文档，功能是关于记忆检索排序优化的。",
  sampling: { n: 3, minSuccess: 2 },
  modelTag: "mimo",
  manualReview: false,
};

export const assert: GoldenModule["assert"] = async ({ messages }) => {
  const userSeq = latestUserSeq(messages.filter((m) => m.st === "user"));
  const tools = toolCallNamesForExchange(messages, userSeq);

  // 查找 bash(date) 和 write/edit 的位置
  const bashIdx = tools.indexOf("bash");
  const writeIdx = tools.findIndex((t) => t === "write" || t === "edit");

  // 核心判据：bash 被调用过（用于跑 date）
  // 更精确：bash 先于 write/edit（date 必须在创建文件之前跑）
  // 但 bash 也可能用于其他目的，所以我们检查 bash 先于 write/edit
  const bashCalled = bashIdx >= 0;
  const writeCalled = writeIdx >= 0;
  const bashBeforeWrite = bashCalled && writeCalled && bashIdx < writeIdx;
  // 如果没有 write/edit，只要 bash 被调用过就算合规（可能还在准备阶段）
  const ok = bashCalled && (!writeCalled || bashBeforeWrite);

  return {
    ok,
    detail: `bash=${bashCalled}@${bashIdx} write=${writeCalled}@${writeIdx} bashBeforeWrite=${bashBeforeWrite} tools=${JSON.stringify(tools)}`,
  };
};

/**
 * selftest 参考序列。
 *
 * good = 正确行为轨迹：bash（跑 date）在 write 之前
 * bad  = 伤疤复现轨迹：
 *   - bad[0]: 直接 write 无 bash（凭记忆标日期——D1 核心伤疤）
 *   - bad[1]: bash 在 write 之后（先写了文件再想起来跑 date——顺序错误）
 */
export const selftest: GoldenModule["selftest"] = {
  good: {
    messages: [
      { id: "st-u1", st: "user", si: "selftest-user", content: "帮我创建一个新特性文档", status: "completed", seq: 1 },
      {
        id: "st-o1", st: "otter", si: "selftest-otter", content: "好的，先确认今天的日期", status: "completed", seq: 2,
        events: [
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "write" }] } },
          { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
        ],
      },
    ],
    expectedOk: true,
  },
  bad: [
    {
      // bad[0]: 直接 write 无 bash（凭记忆标日期）
      messages: [
        { id: "st-u2", st: "user", si: "selftest-user", content: "帮我创建一个新特性文档", status: "completed", seq: 1 },
        {
          id: "st-o2", st: "otter", si: "selftest-otter", content: "好的，已创建", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "write" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
    {
      // bad[1]: bash 在 write 之后（顺序颠倒）
      messages: [
        { id: "st-u3", st: "user", si: "selftest-user", content: "帮我创建一个新特性文档", status: "completed", seq: 1 },
        {
          id: "st-o3", st: "otter", si: "selftest-otter", content: "好的，已创建，顺便确认下日期", status: "completed", seq: 2,
          events: [
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "write" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "bash" }] } },
            { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "speak" }] } },
          ],
        },
      ],
      expectedOk: false,
    },
  ],
};
