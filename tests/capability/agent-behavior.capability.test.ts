/**
 * 能力测试：獭的主动行为——术语捕获与 skill 触发。
 *
 * 两者都是纯 LLM 决策行为（"搭档定义了术语 → add_terminology"、
 * "任务匹配 skill 触发词 → read SKILL.md"），统计采样断言。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  toolCallNames,
  expectSampledBehavior,
  type MessageDto,
} from "./helpers/assert-behavior";

/** 工具调用参数序列化（断言 read 了哪个文件） */
function toolCallArgsText(message: MessageDto): string {
  const parts: string[] = [];
  for (const ev of message.events ?? []) {
    if (ev.eventType !== "assistant_toolcall") continue;
    for (const item of ev.payload?.content ?? []) {
      if (item.type === "toolCall") parts.push(JSON.stringify(item.arguments ?? {}));
    }
  }
  return parts.join("\n");
}

describe("獭的主动行为：术语捕获 + skill 触发（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("术语捕获：搭档明确定义新词后獭调用 add_terminology 入库（3 次采样 ≥1）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("terminology-capture", 3, 1, async (i) => {
      const term = `獭式检索${["阿尔法", "贝塔", "伽马"][i]}`;
      const convId = await createConversation(ctx, `术语采样${i + 1}`);
      await sendUserMessage(
        ctx,
        convId,
        `我们约定一个术语：「${term}」，它的定义是：水獭用尾巴拍打水面来定位鱼群的方法。请记住这个词。`,
      );
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 150_000 });

      const tools = toolCallNames(answer);
      const called = tools.includes("add_terminology");
      /** 工具未调用也可能后来补（异步），以入库为最终判据 */
      const stored = (ctx.built.db.prepare("SELECT COUNT(*) AS n FROM terminology_entries WHERE term = ?").get(term) as { n: number }).n > 0;
      return {
        ok: called || stored,
        detail: `called=${called} stored=${stored} tools=${JSON.stringify(tools)}`,
      };
    });
  }, 600_000);

  it("skill 触发：实现类请求触发獭 read core-workflow SKILL.md（3 次采样 ≥1）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("skill-triggering", 3, 1, async (i) => {
      const convId = await createConversation(ctx, `skill 采样${i + 1}`);
      /** 只做需求分析、明确禁止写代码：既触发 core-workflow，又避免真实现
       *  （曾在真仓 worktree 里跑 25 个工具调用完整实现——副作用与耗时双高） */
      await sendUserMessage(
        ctx,
        convId,
        "我打算加一个返回当前时间戳的工具脚本。请按你的工作流程先做需求分析，只给分析结论，不要写任何代码。",
      );
      const answer = await waitForOtterMessage(ctx, convId, { timeoutMs: 150_000 });

      const tools = toolCallNames(answer);
      const argsText = toolCallArgsText(answer);
      const readSkill = /SKILL\.md/.test(argsText) || /core-workflow/.test(argsText);
      return {
        ok: readSkill,
        detail: `readSkill=${readSkill} tools=${JSON.stringify(tools)}`,
      };
    });
  }, 600_000);
});
