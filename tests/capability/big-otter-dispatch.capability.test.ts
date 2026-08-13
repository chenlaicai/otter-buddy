/**
 * 能力测试：大獭召唤后派工（big-otter dispatch）
 *
 * F20260813actk: 验证大獭 create_otter 后把行动权（talkingStonePassedTo）传给新建小獭，
 * 不传 'user'。修复前生产数据：纯失败 10.0% / 含批量部分丢失 21.4%；批量创建 57.1% 失败率。
 * 失败签名——大獭 body 写"正在并行检视"，真心以为 create=派工。
 *
 * 覆盖验收场景：
 * - AT-1（单只）：大獭召唤 1 只小獭后 speak，tsp 含小獭 ID 不含 user（5 次采样 ≥4）
 * - AT-2（批量 4 只）：大獭召唤 4 只后 speak，tsp 含全部 4 只 ID（7 次采样 ≥5）
 *
 * AT-3（小獭回传大獭）/AT-4（终审传 user）由 talking-stone-routing.capability.test.ts 覆盖回程，
 * 本文件聚焦去程派工（大獭→小獭）。
 *
 * 测试设计要点（继承 F20260810rout 经验）：
 * - 真系统 + 真 LLM（mimo），不能用 mock
 * - 任务极简（确认到岗），避免 mimo 重任务下退化干扰路由验证
 * - 阈值经二项分布计算：3 次 ≥2 在 p=0.7 时 78% 通过率（过宽）；5 次 ≥4 / 7 次 ≥5 才能检测修复有效性
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import {
  createConversation,
  sendUserMessage,
  waitForOtterMessage,
  listMessages,
  expectSampledBehavior,
  type MessageDto,
} from "./helpers/assert-behavior";

/** 找大獭（type=big）的 completed 发言中含 talking_stone_passed_to 的最后一条 */
function findBigOtterDispatchMessage(messages: MessageDto[], bigOtterId: string): MessageDto | undefined {
  return messages
    .filter((m) => m.st === "otter" && m.si === bigOtterId && m.status === "completed" && m.tsp && m.tsp.length > 0)
    .sort((a, b) => b.seq - a.seq)[0];
}

describe("大獭召唤后派工：create 后 speak 传给小獭不传 user（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("AT-1 单只：大獭召唤 1 只小獭后 tsp 含小獭 ID 不含 user（5 次采样 ≥4）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("big-otter-dispatch-single", 5, 4, async (i) => {
      const ottersBefore = new Set(
        (ctx.built.db.prepare("SELECT id FROM otters").all() as Array<{ id: string }>).map((r) => r.id),
      );

      const convId = await createConversation(ctx, `派工单只${i + 1}`);

      await sendUserMessage(
        ctx,
        convId,
        "召唤一只小獭名叫'报告獭'，让它用一句话确认到岗。召唤后请把发言权传给它让它开工。",
      );

      /** 等大獭完成（create + speak 派工在同一 agent turn） */
      const bigOtterMsg = await waitForOtterMessage(ctx, convId, { timeoutMs: 180_000 });

      /** diff 出新召唤的小獭 */
      const newOtters = (ctx.built.db.prepare("SELECT id, name, type FROM otters").all() as Array<Record<string, string>>)
        .filter((r) => !ottersBefore.has(r.id));
      const smallOtter = newOtters.find((r) => r.type === "small");
      if (!smallOtter) {
        return { ok: false, detail: "大獭未召唤小獭" };
      }

      /** 核心断言：大獭派工消息的 tsp 含小獭 ID，不含 user */
      const messages = await listMessages(ctx, convId);
      const dispatchMsg = findBigOtterDispatchMessage(messages, bigOtterMsg.si);
      if (!dispatchMsg) {
        return { ok: false, detail: "大獭无含 tsp 的 completed 发言" };
      }

      const tsp = dispatchMsg.tsp ?? [];
      const passedToUser = tsp.includes("user");
      const passedToSmall = tsp.includes(smallOtter.id);

      return {
        ok: passedToSmall && !passedToUser,
        detail: `小獭=${smallOtter.name} tsp=${JSON.stringify(tsp)} match=${passedToSmall} body="${dispatchMsg.content.slice(0, 60)}"`,
      };
    });
  }, 3_000_000); // 50 分钟超时（5 次采样）

  it("AT-2 批量 4 只：大獭召唤 4 只后 tsp 含全部 4 只 ID（7 次采样 ≥5）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("big-otter-dispatch-batch", 7, 5, async (i) => {
      const ottersBefore = new Set(
        (ctx.built.db.prepare("SELECT id FROM otters").all() as Array<{ id: string }>).map((r) => r.id),
      );

      const convId = await createConversation(ctx, `派工批量${i + 1}`);

      await sendUserMessage(
        ctx,
        convId,
        "召唤 4 只小獭，分别叫'甲獭''乙獭''丙獭''丁獭'，每只都用一句话确认到岗。" +
        "召唤完后请把发言权一次性传给全部 4 只（talkingStonePassedTo 传 4 个名字），让它们并行开工。",
      );

      const bigOtterMsg = await waitForOtterMessage(ctx, convId, { timeoutMs: 240_000 });

      const newOtters = (ctx.built.db.prepare("SELECT id, name, type FROM otters").all() as Array<Record<string, string>>)
        .filter((r) => !ottersBefore.has(r.id));
      const newSmalls = newOtters.filter((r) => r.type === "small");

      /** 大獭至少要召唤到小獭（数量不达标也算失败，但不 skip） */
      if (newSmalls.length === 0) {
        return { ok: false, detail: "大獭未召唤任何小獭" };
      }

      const messages = await listMessages(ctx, convId);
      const dispatchMsg = findBigOtterDispatchMessage(messages, bigOtterMsg.si);
      if (!dispatchMsg) {
        return { ok: false, detail: "大獭无含 tsp 的 completed 发言" };
      }

      const tsp = dispatchMsg.tsp ?? [];
      const smallIds = new Set(newSmalls.map((r) => r.id));
      const coveredCount = tsp.filter((id) => smallIds.has(id)).length;
      const passedToUser = tsp.includes("user");
      const allCovered = coveredCount === newSmalls.length && newSmalls.length >= 4;

      return {
        ok: allCovered && !passedToUser,
        detail: `召唤 ${newSmalls.length} 只（${newSmalls.map((r) => r.name).join(",")}） tsp 覆盖 ${coveredCount}/${newSmalls.length} user=${passedToUser} body="${dispatchMsg.content.slice(0, 80)}"`,
      };
    });
  }, 4_200_000); // 70 分钟超时（7 次采样 × 批量更慢）
});
