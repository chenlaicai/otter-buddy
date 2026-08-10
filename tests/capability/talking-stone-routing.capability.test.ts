/**
 * 能力测试：发言权路由（talking-stone routing）
 *
 * F20260810rout: 验证子獭（被大獭召唤的小獭）完成本职后，发言权传回召唤者（大獭），
 * 不传 'user'。修复前 8/8 检视獭首轮传 user（bug）；修复后（注入召唤者身份）
 * 应稳定传回召唤者。
 *
 * 测试设计要点：
 * - 真系统 + 真 LLM（mimo），不能用 mock
 * - 大獭召唤小獭 + 把发言权传给小獭（还原生产场景的真实链路）
 * - 小獭任务极简（确认到岗），避免 mimo 在重任务下退化干扰路由验证
 * - 统计采样（3 次至少 2 次成功）应对 LLM 随机性
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

/**
 * 找到子獭（非大獭的 small 类型 otter）的最终 completed 发言。
 * 大獭在召唤后会把发言权传给子獭，子獭 speak 完成后的消息就是要验证的目标。
 */
function findSmallOtterMessage(messages: MessageDto[], smallOtterId: string): MessageDto | undefined {
  return messages
    .filter((m) => m.st === "otter" && m.si === smallOtterId && m.status === "completed")
    .sort((a, b) => b.seq - a.seq)[0];
}

describe("发言权路由：子獭完成本职后传回召唤者（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("子獭被大獭召唤并完成发言后，talkingStonePassedTo 包含大獭、不传 'user'（3 次采样 ≥2）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("talking-stone-routing", 3, 2, async (i) => {
      /** 记录采样前的 otter 集合，事后 diff 出新召唤的子獭 */
      const ottersBefore = new Set(
        (ctx.built.db.prepare("SELECT id FROM otters").all() as Array<{ id: string }>).map((r) => r.id),
      );

      const convId = await createConversation(ctx, `路由采样${i + 1}`);

      /** 发消息让大獭召唤子獭 + 把发言权传给子獭 + 子獭极简任务 */
      await sendUserMessage(
        ctx,
        convId,
        "召唤一只小獭名叫'报告獭'。召唤完后请你把发言权传给它，让它用一句话确认到岗后 speak 交付。",
      );

      /** 等大獭召唤完成（大獭会 speak 传给子獭） */
      const bigOtterMsg = await waitForOtterMessage(ctx, convId, { timeoutMs: 180_000 });

      /** 找到新召唤的子獭 */
      const newOtters = (ctx.built.db.prepare("SELECT id, name, type, parent_otter_id FROM otters").all() as Array<Record<string, string>>)
        .filter((r) => !ottersBefore.has(r.id));
      const smallOtter = newOtters.find((r) => r.type === "small");
      if (!smallOtter) {
        return { ok: false, detail: `大獭未召唤小獭（bigOtterTools 看消息事件）` };
      }

      /** 等子獭发言完成（在大獭消息之后） */
      try {
        await waitForOtterMessage(ctx, convId, {
          timeoutMs: 300_000,
          afterSeq: bigOtterMsg.seq,
        });
      } catch {
        /** 子獭可能卡住或退化，继续检查已有消息 */
      }

      const messages = await listMessages(ctx, convId);
      const smallMsg = findSmallOtterMessage(messages, smallOtter.id);
      if (!smallMsg) {
        return { ok: false, detail: `子獭 ${smallOtter.name} 未产出 completed 消息` };
      }

      /** 核心断言：tsp 应包含大獭 ID，不应是 ['user']。
       *  注意：DB 的 talking_stone_passed_to 存的是 resolved ID（不是名字），
       *  message DTO 的 tsp 字段直接透传 DB 值。 */
      const bigOtterId = newOtters.find((r) => r.type === "big")?.id
        ?? (ctx.built.db.prepare("SELECT parent_otter_id FROM otters WHERE id = ?").get(smallOtter.id) as { parent_otter_id: string }).parent_otter_id;

      const tsp = smallMsg.tsp ?? [];
      const passedToUser = tsp.includes("user");
      const passedToBigOtter = tsp.includes(bigOtterId);

      return {
        ok: passedToBigOtter && !passedToUser,
        detail: `子獭=${smallOtter.name} tsp=${JSON.stringify(tsp)} bigOtterId=${bigOtterId.slice(0, 8)} match=${passedToBigOtter} body="${smallMsg.content.slice(0, 60)}"`,
      };
    });
  }, 1_800_000); // 30 分钟超时（3 次采样 × 每次最多 ~6 分钟）
});
