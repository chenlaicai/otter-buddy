/**
 * 能力测试：track_work 工具调用纪律（F20261027hwl1 B 类）。
 *
 * 新增 LLM 行为面：track_work 工具的 description 约束——
 * ①新独立目标 → 獭应 start（title 一句话 + 系统注入 traceId 绑定）
 * ②同目标追问（新 user turn）→ 不另起 start（新链默认不继承，本测验证「不重复登记」下限）
 * ③闲聊/临时问答 → 不建工作（Not for 边界）
 *
 * 断言策略：LLM 是否调工具/何时调是行为面——采样统计（3 采样 ≥2）；
 * 落库字段（trace 绑定、originKind）是机械行为——严格断言。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "../helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  waitForInvokeSettled,
  expectSampledBehavior,
} from "../helpers/assert-behavior";

describe("track_work：新目标登记 + 不滥用边界（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it(
    "① 明确新工作指令 → 獭调 track_work start，工作落库且 trace 绑定在案（3 采样 ≥2）",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      await expectSampledBehavior("track-work-start", 3, 2, async (i) => {
        const convId = await createConversation(ctx, `工作登记采样${i + 1}`);

        /** 指令设计：明确「一件事有独立目标的工作」语义，要求用工具登记。
         *  不提示具体参数——验证獭从工具 description 自取契约（title/action）。 */
        await sendUserMessage(
          ctx,
          convId,
          "我要开始一件独立工作：为仓库根目录加一个 CONTRIBUTING.md（目标、边界、结束状态都独立）。" +
          "请用 track_work 工具把这件事登记进工作账本，登记完成后用一句话告诉我工作 ID。不要做其他事。",
        );

        try {
          const first = await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
          // 大獭 invoke 终态后工具副作用才完整（speak 早于工具收尾的窗口）
          await waitForInvokeSettled(ctx, convId, first.si, { timeoutMs: 60_000 });
        } catch {
          return { ok: false, detail: "大獭未在超时内应答" };
        }

        /** 确定性断言：work_items 落库 + trace 绑定（机械行为，严格） */
        const works = ctx.built.db.prepare(
          "SELECT id, title, origin_kind, evidence_quality FROM work_items WHERE conversation_id = ?",
        ).all(convId) as Array<Record<string, string>>;
        if (works.length === 0) {
          return { ok: false, detail: "work_items 无登记——獭未调 track_work start（LLM 行为偏差或工具未注册）" };
        }
        const w = works[0];
        if (!w.title || w.title.trim().length < 2) {
          return { ok: false, detail: `title 异常：「${w.title}」` };
        }
        const bindings = ctx.built.db.prepare(
          "SELECT COUNT(*) AS c FROM work_item_traces WHERE work_id = ?",
        ).get(w.id) as { c: number };
        if (bindings.c === 0) {
          return { ok: false, detail: "trace 未绑定——start 的 traceId 注入失效（机制 bug 非 LLM 偏差）" };
        }
        return { ok: true, detail: `登记 ${w.id.slice(0, 8)}「${w.title.slice(0, 30)}」绑定 ${bindings.c} 条 trace` };
      });
    },
    1_200_000,
  );

  it(
    "② 闲聊不建工作（Not for 边界）：一句寒暄后 work_items 无新增",
    async (t) => {
      if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

      await expectSampledBehavior("track-work-no-chitchat", 3, 2, async (i) => {
        const convId = await createConversation(ctx, `闲聊采样${i + 1}`);
        await sendUserMessage(ctx, convId, "今天天气不错，随便聊聊，不用做任何登记或工具操作，回一句就行。");
        try {
          const first = await waitForOtterMessage(ctx, convId, { timeoutMs: 300_000 });
          // 大獭 invoke 终态后工具副作用才完整（speak 早于工具收尾的窗口）
          await waitForInvokeSettled(ctx, convId, first.si, { timeoutMs: 60_000 });
        } catch {
          return { ok: false, detail: "大獭未在超时内应答" };
        }
        const works = ctx.built.db.prepare(
          "SELECT COUNT(*) AS c FROM work_items WHERE conversation_id = ?",
        ).get(convId) as { c: number };
        if (works.c > 0) {
          return { ok: false, detail: `闲聊对话出现 ${works.c} 件工作登记——违反 Not for 边界（滥用 start）` };
        }
        return { ok: true, detail: "无登记（正确）" };
      });
    },
    1_200_000,
  );
});
