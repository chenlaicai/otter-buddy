/**
 * F20261027hwl1：track_work 工具——工作账本的獭侧写端口。
 *
 * 归属原则（特性文档「归属规则」节）：
 * - start：新独立目标（title 一句话）→ 创建工作 + 绑定当前整条 trace
 * - resume：已有 workId 续接（新 user turn 的显式声明；新链默认不继承）
 * - complete/cancel：只记工作投影状态，不越权闭合 matter/PR
 * - review_round：结构化检视轮次留痕（reviewing/awaiting-fix/delta-review/passed，
 *   自动携带当前 invokeId 作证据）——不用「发言出现 delta/通过」等文本计数
 *
 * traceId 从 AsyncLocalStorage trace scope 读（链引擎/直连入口已注入）——
 * 确定性锚点，非 LLM 自称。无 traceId 时明确报错（归属无从谈起，不静默假成功）。
 * 失败不阻断业务 invoke（观测投影）：工具返回错误文本，主路径照常。
 */
import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import type { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { getTraceContext } from "@usecases/ports/trace-context";

const VALID_COMPLETION = ["delivered", "merged", "closed"] as const;
const VALID_ROUND_STATES = ["reviewing", "awaiting-fix", "delta-review", "passed", "open-unknown"] as const;

type Completion = (typeof VALID_COMPLETION)[number];
type RoundState = (typeof VALID_ROUND_STATES)[number];

function str(params: Record<string, unknown>, key: string): string {
  return String(params[key] ?? "").trim();
}

/** start 分支：新工作 + 绑定当前 trace */
async function handleStart(binder: WorkLedgerBinder, ctx: ToolContext, params: Record<string, unknown>, traceId: string | undefined) {
  const title = str(params, "title");
  if (!title) return "[track_work] start 需要 title（一句话工作名）";
  if (!traceId) return "[track_work] 当前无 trace 上下文——工作归属需要链级 traceId，无法 start（可先正常干活，账目进未归属）";
  const originKind = params.originKind === "feature" || params.originKind === "matter" ? params.originKind : "manual";
  const work = await binder.start({
    conversationId: ctx.conversationId,
    otterId: ctx.otterId,
    traceId,
    title,
    originKind,
    originId: params.originId ? String(params.originId) : null,
  });
  return `工作已登记并绑定当前链：workId=${work.id} title=「${work.title}」 traceId=${traceId}。当前链的全部调用将归入此工作。`;
}

/** resume 分支：已有工作续接新链 */
async function handleResume(binder: WorkLedgerBinder, ctx: ToolContext, params: Record<string, unknown>, traceId: string | undefined) {
  const workId = str(params, "workId");
  if (!workId) return "[track_work] resume 需要 workId（从 start 返回或工作列表取）";
  if (!traceId) return "[track_work] 当前无 trace 上下文——resume 需要绑定新链的 traceId";
  const work = await binder.resume({ conversationId: ctx.conversationId, otterId: ctx.otterId, workId, traceId });
  if (!work) return `[track_work] workId=${workId} 不存在或已取消，无法 resume`;
  return `工作续接成功：workId=${work.id} title=「${work.title}」 新链 traceId=${traceId} 已绑定。`;
}

/** complete/cancel 分支：工作投影终态 */
async function handleComplete(binder: WorkLedgerBinder, params: Record<string, unknown>) {
  const workId = str(params, "workId");
  const status = str(params, "status");
  if (!workId) return "[track_work] complete 需要 workId";
  if (!VALID_COMPLETION.includes(status as Completion)) {
    return `[track_work] status 必须是 ${VALID_COMPLETION.join(" / ")} 之一`;
  }
  const work = await binder.complete(workId, status as Completion);
  if (!work) return `[track_work] workId=${workId} 不存在`;
  return `工作已记终态 ${status}：workId=${workId}。注意这只记工作投影状态，matter/PR 生命周期由各自机制管理。`;
}

async function handleCancel(binder: WorkLedgerBinder, params: Record<string, unknown>) {
  const workId = str(params, "workId");
  if (!workId) return "[track_work] cancel 需要 workId";
  const work = await binder.cancel(workId);
  if (!work) return `[track_work] workId=${workId} 不存在`;
  return `工作已取消（沉没成本保留在账本）：workId=${workId}`;
}

/** review_round 分支：结构化轮次留痕（invoke 证据自动携带） */
async function handleReviewRound(binder: WorkLedgerBinder, ctx: ToolContext, params: Record<string, unknown>) {
  const workId = str(params, "workId");
  const reviewerOtterId = str(params, "reviewerOtterId");
  const roundNo = Number(params.roundNo);
  const roundState = str(params, "roundState");
  if (!workId || !reviewerOtterId) return "[track_work] review_round 需要 workId + reviewerOtterId";
  if (!Number.isInteger(roundNo) || roundNo < 1) return "[track_work] roundNo 必须是 ≥1 的整数";
  if (!VALID_ROUND_STATES.includes(roundState as RoundState)) {
    return `[track_work] roundState 必须是 ${VALID_ROUND_STATES.join(" / ")} 之一`;
  }
  const nowIso = new Date().toISOString();
  const state = roundState as RoundState;
  // invoke 证据自动携带：当前 invoke 即该轮次的链活动证据（结构化，非文本猜测）
  await binder.recordReviewRound(workId, {
    roundNo,
    reviewerOtterId,
    state,
    ...(state === "reviewing" && { startedInvokeId: ctx.currentInvokeId ?? null, startedAt: nowIso }),
    ...(state === "delta-review" && { deltaInvokeId: ctx.currentInvokeId ?? null, deltaAt: nowIso }),
    ...(state === "passed" && { passedAt: nowIso }),
  });
  return `检视轮次已留痕：workId=${workId} 第 ${roundNo} 轮 → ${state}${ctx.currentInvokeId ? `（invoke 证据：${ctx.currentInvokeId}）` : ""}`;
}

export function createTrackWorkTool(ctx: ToolContext, binder: WorkLedgerBinder): AgentTool {
  return {
    name: "track_work",
    description: "工作账本登记工具——把当前链的消耗归到一件独立工作上. When: 开始一件有独立目标/边界/结束状态的新工作（start）；搭档追问/继续属于当前工作但已开新链时显式续接（resume）；工作交付/合入/取消时记终态（complete/cancel）；独立检视轮次开启/推进/通过时留痕（review_round）. Not for: 闲聊/临时问答不建工作；matters 裁决（→ transition_matter）；工作状态不联动 matter/PR 生命周期. Output: 工作 ID + 归属绑定确认. GOTCHA: start 的 title 是一句话工作名（如「修复每日派工漏提醒」），不是对话标题；同一对话多件工作分别 start；新 user turn 默认不继承旧工作——继续做同一件事必须 resume. BOUNDARY: workId/traceId 由系统注入，不可伪造归属.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "start | resume | complete | cancel | review_round" },
        title: { type: "string", description: "action=start 必填：一句话工作名（独立目标）" },
        workId: { type: "string", description: "resume/complete/cancel/review_round 必填：已有工作 ID" },
        originKind: { type: "string", description: "可选：feature | matter（有对应 F 文档/matter 锚点时填，建立 origin 关联）" },
        originId: { type: "string", description: "可选：F 文档编号或 matter ID" },
        status: { type: "string", description: "action=complete 必填：delivered | merged | closed" },
        reviewerOtterId: { type: "string", description: "action=review_round 必填：独立检视獭 ID" },
        roundNo: { type: "number", description: "action=review_round 必填：轮次号（从 1 起）" },
        roundState: { type: "string", description: "action=review_round 必填：reviewing | awaiting-fix | delta-review | passed | open-unknown" },
      },
      required: ["action"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const traceId = getTraceContext().traceId;
      try {
        const action = str(params, "action");
        switch (action) {
          case "start": return textResponse(await handleStart(binder, ctx, params, traceId));
          case "resume": return textResponse(await handleResume(binder, ctx, params, traceId));
          case "complete": return textResponse(await handleComplete(binder, params));
          case "cancel": return textResponse(await handleCancel(binder, params));
          case "review_round": return textResponse(await handleReviewRound(binder, ctx, params));
          default: return errorResponse(`[track_work] 未知 action「${action}」——支持 start / resume / complete / cancel / review_round`);
        }
      } catch (err) {
        // 观测投影失败不阻断业务——错误文本返回，獭可继续正常干活（账目进未归属）
        return errorResponse(`[track_work] 账本登记失败（不影响正常干活，本次调用将进未归属）: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
