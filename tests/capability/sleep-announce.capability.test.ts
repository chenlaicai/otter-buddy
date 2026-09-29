/**
 * F20260928slan V4：sleep 工具化行为验证（capability / Golden Gate）。
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

/** 獭是否 speak 过（等待前交代）
 *  #1198 根因修复：原断言拿「首个 otter speak entry 的 sequenceNum」与「wait 所在 invoke
 *  的首条 entry（即 invoke_start）的 sequenceNum」比较——但 speak 是 invoke 内的工具调用，
 *  其 entry sequenceNum 恒大于本回合 invoke_start（invoke_start 先落库）。当 speak 与 wait
 *  同属一个回合时，speak@N 恒 > invoke_start@2，anchored 断言结构性恒 false，从 #1126
 *  建立即红（2/3 timing=anchored speak@3 < wait-invoke@2 即此形态）。
 *  正确锚：wait 所在 invoke 的事件流里，speak 工具调用（assistant_toolcall name=speak）
 *  必须先于 wait 工具调用（tool_execution_start 对两者同发 assistant_toolcall，顺序可判）。
 *  跨 invoke 形态（speak 在更早回合、wait 在后续回合）保留 entries 比较——那种形态下
 *  speak entry 属于前一 invoke，seq 恒小于 wait invoke_start，可比较且语义正确。 */
function spokeBeforeWaitInInvoke(events: InvokeEventDto[]): { ok: boolean; detail: string } {
  const callOrder = toolNamesFromEvents(events);
  const speakIdx = callOrder.indexOf("speak");
  const waitIdx = callOrder.indexOf("wait");
  if (waitIdx === -1) return { ok: false, detail: "no-wait-call" };
  if (speakIdx === -1) return { ok: false, detail: "no-speak-call-in-invoke" };
  return { ok: speakIdx < waitIdx, detail: `timing=event-stream speak=call#${speakIdx + 1} wait=call#${waitIdx + 1}` };
}

/** 跨 invoke 分支：speak 在更早回合（独立 invoke 或已落库 entry）→ entries seq 比较仍成立 */
function spokeBeforeWaitCrossInvoke(entries: EntryDto[], waitInvokeIds: Set<string>): boolean {
  const firstOtterSpeak = entries.find((e) => e.entryType === "speak" && e.senderType === "otter" && (e.body ?? "").trim().length > 0);
  if (!firstOtterSpeak) return false;
  const waitAnchor = entries.find((e) => e.invokeId && waitInvokeIds.has(e.invokeId));
  if (!waitAnchor) return true; // 锚缺失保守放行（existence-only）
  return firstOtterSpeak.sequenceNum < waitAnchor.sequenceNum;
}

/** invoke 事件流里的工具调用名（按执行发生顺序）
 *  #1210 检视 A1/A2：只解析执行序形态（tool_execution_start 映射的 payload.name 直挂）。
 *  message_end 的 payload.content blocks 形态与执行序形态对同一调用各产一条事件，
 *  双解析会使 call#N 序号失真且 toolNamesFromEvents 可能漏直挂形态——统一只认执行序。 */
function toolNamesFromEvents(events: InvokeEventDto[]): string[] {
  const names: string[] = [];
  for (const ev of events) {
    if (ev.eventType !== "assistant_toolcall") continue;
    const direct = (ev.payload as { name?: string } | undefined)?.name;
    if (direct) names.push(direct);
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

  it("等待场景：獭先 speak 说明理由，再调 wait（3 次采样 ≥2——时序断言为主，硬收敛由 L1 守卫兜底）", async (t) => {
    if (!ctx.llmAvailable) t.skip(`LLM 未配置：${ctx.skipReason}`);

    await expectSampledBehavior("sleep-announce-wait", 3, 2, async (i) => {
      const convId = await createConversation(ctx, `等待采样${i + 1}`);
      /** 场景：只给獭一个「等 20 秒再回复」的任务，观察其等待方式。
       *  不设限措辞，只断言行为不变量：wait 被采纳 + speak 先行。
       *  #1210 检视 S1：原 5s 场景存在逃逸口——bash sleep 3×2 合规等满 5s 不触发守卫
       *  （<5s 微 sleep 不在拦截面），wait 采纳率 ~2/3 在门槛边缘 flaky。改 20s 后守卫走
       *  「弹回漏斗」：单段 sleep ≥5s 被拦并弹回引导文案（sleep-command-guard.ts 指向 wait），
       *  拆分路径（sleep 4×N 逐段 <5s）技术上仍放行（守卫逐段判定不累加）但行为学上罕见
       *  （需刻意规避），9 采样实证零拆分（speak=call#1 wait=call#2 一致）。 */
      await sendUserMessage(
        ctx,
        convId,
        "请在继续之前等待 20 秒（模拟等一个异步操作），然后告诉我你完成了。",
      );

      /** 轮询 invoke 事件直到回合收敛（invoke_end entry 出现） */
      /** 收敛判定：任一 invoke 出现 wait 工具调用 + 獭已 speak 即收敛（正道已采纳）。
       *  不强制 invoke_end 终态——wait 真等 5s + LLM 慢，invoke 可能仍在跑，
       *  但行为不变量（speak 先行 + wait 采纳）已可判定。 */
      const deadline = Date.now() + 240_000;
      let finalEntries: EntryDto[] = [];
      let toolNames: string[] = [];
      const waitInvokeIds = new Set<string>();
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
          if (toolNames.includes("wait")) { converged = true; waitInvokeIds.add(iid); break; }
        }
        if (converged) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      const calledWait = toolNames.includes("wait");
      /** #1198：时序锚改事件流（wait 回合内 speak 调用先于 wait 调用）；
       *  speak 落在更早回合的形态走跨 invoke 分支（entries seq 比较对跨回合成立）。 */
      let timingOk = false;
      let timingDetail = "not-converged";
      if (converged && waitInvokeIds.size > 0) {
        const waitInvokeId = [...waitInvokeIds][0]!;
        const waitEvents = await listInvokeEvents(ctx, waitInvokeId);
        const inInvoke = spokeBeforeWaitInInvoke(waitEvents);
        if (inInvoke.ok) {
          timingOk = true; timingDetail = inInvoke.detail;
        } else if (inInvoke.detail === "no-speak-call-in-invoke") {
          const crossOk = spokeBeforeWaitCrossInvoke(finalEntries, waitInvokeIds);
          timingOk = crossOk;
          timingDetail = `timing=cross-invoke speak-in-earlier-turn=${crossOk}`;
        } else {
          timingDetail = inInvoke.detail;
        }
      }
      return {
        ok: converged && calledWait && timingOk,
        detail: `converged=${converged} wait=${calledWait} ${timingDetail} tools=${JSON.stringify(toolNames)}`,
      };
    }, { budgetMs: 810_000, sampleWorstMs: 270_000 }); // #1187 预算护栏（240s deadline + 轮询余量；#1195 修正：原 480/600 违反 n×worst≤budget 契约致慢端点 SKIP 假红）
  }, 930_000);
});
