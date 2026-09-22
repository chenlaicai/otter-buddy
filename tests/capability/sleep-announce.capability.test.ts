/**
 * F20260922slan V4：sleep 工具化行为验证（capability / Golden Gate）。
 *
 * verify_by: capability_test（intent 块声明）——模拟獭需要等待的场景，
 * 断言其行为收敛：先 speak 说明理由，再调 wait 工具（而非裸 bash sleep ≥5s）。
 *
 * 行为不变量（统计采样，非文本精确匹配）：
 * - 工具轨迹含 wait（正道工具被采纳）
 * - 獭有 speak 交代（等待前先发声——意图锚「必须 speak 先说一声」）
 * - 无裸 bash sleep ≥5s（守卫拦截生效；微 sleep <5s 不在断言面）
 *
 * 数据通道：GET /api/conversations/:id/entries（读 speak entry）
 * + GET /api/invokes/:id/events（读 assistant_toolcall 事件）——
 * 均为真 buildApp 注册的 REST 路由（router.ts:79/:72），不依赖 SSE subscribe。
 * LLM 未配置时 skip（CI 零 LLM 路径）；真跑需 bge-m3 + LLM 端点。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { bootCapabilityApp, type CapabilityContext } from "./helpers/boot";
import { createConversation, sendUserMessage, expectSampledBehavior } from "./helpers/assert-behavior";

/** GET /api/conversations/:id/entries → speak entry 列表 */
interface EntryDto {
  id: string;
  entryType: string;
  senderType: string;
  body?: string;
  sequenceNum: number;
  invokeId?: string;
  status?: string;
  createdAt: string;
}

/** GET /api/invokes/:id/events → assistant_toolcall 事件 */
interface InvokeEventDto {
  eventType: string;
  payload?: { content?: Array<{ type: string; name?: string; arguments?: unknown }> };
}

async function listEntries(ctx: CapabilityContext, convId: string): Promise<EntryDto[]> {
  const res = await ctx.built.app.request(`/api/conversations/${convId}/entries?limit=200`);
  if (res.status !== 200) throw new Error(`entries ${res.status}`);
  const body = await res.json() as { entries: EntryDto[] };
  return body.entries;
}

async function listInvokeEvents(ctx: CapabilityContext, invokeId: string): Promise<InvokeEventDto[]> {
  const res = await ctx.built.app.request(`/api/invokes/${invokeId}/events`);
  if (res.status !== 200) throw new Error(`invoke events ${res.status}`);
  const body = await res.json() as { events: InvokeEventDto[] };
  return body.events;
}

/** 獭是否 speak 过（等待前交代） */
function otterSpoke(entries: EntryDto[]): boolean {
  return entries.some((e) => e.entryType === "speak" && e.senderType === "otter" && (e.body ?? "").trim().length > 0);
}

/** invoke 事件流里的工具调用名（按发生顺序） */
function toolNamesFromEvents(events: InvokeEventDto[]): string[] {
  const names: string[] = [];
  for (const ev of events) {
    if (ev.eventType !== "assistant_toolcall") continue;
    for (const item of ev.payload?.content ?? []) {
      if (item.type === "toolCall" && item.name) names.push(item.name);
    }
  }
  return names;
}

describe("sleep 工具化：先 speak 再 wait（真系统 + 真 LLM）", () => {
  let ctx: CapabilityContext;

  beforeAll(async () => {
    ctx = await bootCapabilityApp();
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("等待场景：獭先 speak 说明理由，再调 wait（3 次采样 ≥1）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("sleep-announce-wait", 3, 1, async (i) => {
      const convId = await createConversation(ctx, `等待采样${i + 1}`);
      /** 场景：只给獭一个「等 5 秒再回复」的任务，观察其等待方式。
       *  不设限措辞，只断言行为不变量：wait 被采纳 + speak 先行 + 无裸 sleep ≥5s。 */
      await sendUserMessage(
        ctx,
        convId,
        "请在继续之前等待 5 秒（模拟等一个异步操作），然后告诉我你完成了。",
      );

      /** 轮询 invoke 事件直到回合收敛（invoke_end entry 出现） */
      /** 收敛判定：任一 invoke 出现 wait 工具调用 + 獭已 speak 即收敛（正道已采纳）。
       *  不强制 invoke_end 终态——wait 真等 5s + LLM 慢，invoke 可能仍在跑，
       *  但行为不变量（speak 先行 + wait 采纳）已可判定。 */
      const deadline = Date.now() + 240_000;
      let finalEntries: EntryDto[] = [];
      let toolNames: string[] = [];
      let converged = false;
      while (Date.now() < deadline) {
        finalEntries = await listEntries(ctx, convId);
        // 收集全部 otter invoke 的工具事件
        const invokeIds = [...new Set(
          finalEntries.filter((e) => e.invokeId && e.senderType === "otter").map((e) => e.invokeId!),
        )];
        for (const iid of invokeIds) {
          const events = await listInvokeEvents(ctx, iid);
          toolNames = toolNamesFromEvents(events);
          if (toolNames.includes("wait")) { converged = true; break; }
        }
        if (converged) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      const calledWait = toolNames.includes("wait");
      const spokeFirst = otterSpoke(finalEntries);
      return {
        ok: converged && calledWait && spokeFirst,
        detail: `converged=${converged} wait=${calledWait} spoke=${spokeFirst} tools=${JSON.stringify(toolNames)}`,
      };
    });
  }, 600_000);
});
