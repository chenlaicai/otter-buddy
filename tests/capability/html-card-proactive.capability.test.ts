/**
 * 能力测试：html-card 主动引导（F20260825hcpg）。
 *
 * 验证「正向判断标准归位 speak description」后，獭在方案对比/设计类请求下
 * 是否主动用 html-card 卡片承载结构化内容（而非纯 md）——纯 LLM 决策行为，
 * 统计采样断言（沿用 F20260805mspk：行为非确定，单次断言会把套件打成长红）。
 *
 * 设计边界：
 * - 这是概率行为（F20260724 验收口径本就是「非每次都出」），故采样断言
 *   「方案对比场景 3 次采样 ≥1 次出卡」，而非「每次都出」。
 * - 出卡的直接证据 = 獭 completed 消息 content 含 ```html-card 围栏
 *   （实时消息 content 保留卡片原文；剥离成占位符只发生在检索/记忆投影）。
 * - 同一会话连续请求会受上下文污染（出过一次卡后獭可能模仿），故每次采样
 *   用独立会话，保证样本独立。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  expectSampledBehavior,
} from "./helpers/assert-behavior";

/** 獭发言 content 是否携带 html-card 围栏（出卡证据） */
function carriesHtmlCard(content: string): boolean {
  return /```html-card/.test(content);
}

describe("獭的主动行为：html-card 主动引导（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("方案对比请求触发獭主动出卡（3 次采样 ≥1）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("html-card-proactive", 3, 1, async (i) => {
      /** 独立会话保证样本独立（避免同会话出卡后獭模仿的上下文污染） */
      const convId = await createConversation(ctx, `出卡采样${i + 1}`);
      /** 命中 description 场景锚（方案对比/设计思路），但不直接命令「用卡片」——
       *  否则测的是「服从指令」而非「主动引导」，违背本测试目的 */
      await sendUserMessage(
        ctx,
        convId,
        "我在纠结给团队内部工具选前端状态管理方案。帮我对比一下方案 A（Zustand：轻量、API 简洁）和方案 B（Redux Toolkit：生态成熟、DevTools 强），从学习成本、可维护性、适用规模三个维度给个方案展示，帮我决策。",
      );
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });

      const hasCard = carriesHtmlCard(answer.content);
      return {
        ok: hasCard,
        detail: `hasCard=${hasCard} content前120字=${JSON.stringify(answer.content.slice(0, 120))}`,
      };
    });
  }, 600_000);
});
