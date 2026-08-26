/**
 * Signal 工具（F20260826mwrd C1）：halt_otter（大獭停小獭）+ query_signals（台账查询）。
 *
 * halt 语义（方案 Part 3）：mark 打标 → 目标獭下一 tool_call 边界被 block →
 * 指令作为 error tool result 注入 → 目标獭报告进度并 yield。上下文零丢失。
 *
 * C2 增量：resolve_signal（objection/blocked 裁决写路径）——本文件已留位。
 */

import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import { haltRegistry, type HaltDirective } from "@usecases/signal/halt-registry";
import type { Logger } from "@usecases/ports/logger";
import type { SignalQueryFilter, SignalType, SignalEvent } from "@entities/signal/signal-event";

/** halt 打标参数（halt_otter 工具） */
interface HaltParams {
  otterId?: string;
  otterName?: string;
  reason?: string;
}

/**
 * 解析目标 otter + 发起者名字（在场参与者反查）。
 * 返回 error 字段时表示找不到目标。
 */
async function resolveHaltTargets(
  ctx: ToolContext,
  params: HaltParams,
): Promise<{ otterId: string; otterName: string; fromOtterName: string } | { error: string }> {
  const actives = await ctx.client.conversation.participant.getActive(ctx.conversationId);
  const fromName = actives.find(a => a.otterId === ctx.otterId)?.otterName ?? ctx.otterId;
  if (params.otterId) {
    const found = actives.find(a => a.otterId === params.otterId);
    // 不在场（可能 dissolve 后的僵尸 ID）仍允许打标（若它实际还在跑，标会生效），名字回退用 ID
    return { otterId: params.otterId, otterName: found?.otterName ?? params.otterId, fromOtterName: fromName };
  }
  if (params.otterName) {
    const found = actives.find(a => a.otterName === params.otterName);
    if (!found) {
      return { error: `在场参与者中找不到名为「${params.otterName}」的海獭。可先调 get_active_participants 确认名单。` };
    }
    return { otterId: found.otterId, otterName: found.otterName, fromOtterName: fromName };
  }
  return { error: "必须提供 otterId 或 otterName 之一。" };
}

/** halt 落账构造（createHaltOtterTool 内联拆出，控制函数行数） */
function buildHaltSignalEvent(params: {
  signalId: string;
  conversationId: string;
  messageId: string;
  fromOtterId: string;
  targetOtterId: string;
  reason: string;
  now: string;
}): SignalEvent {
  return {
    id: params.signalId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    fromOtterId: params.fromOtterId,
    targetOtterId: params.targetOtterId,
    type: 'halt',
    severity: 'high',
    payload: params.reason,
    status: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: params.now,
  };
}

/** halt_otter：打标 + 落账 signal_events */
export function createHaltOtterTool(ctx: ToolContext, signalRepo: SignalEventRepository, logger?: Logger): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const haltParams: HaltParams = { otterId: params.otterId as string | undefined, otterName: params.otterName as string | undefined };
    const reason = params.reason as string | undefined;

    if (!reason || !reason.trim()) return errorResponse("[错误] reason 必填——halt 指令必须携带停手理由（写入台账，目标獭可见）。");
    const target = await resolveHaltTargets(ctx, haltParams);
    if ('error' in target) return errorResponse(`[错误] ${target.error}`);

    // 自我 halt 无意义（大獭停自己 = abort 语义，方案非目标明确排除搭档→大獭拓扑，同类推）
    if (target.otterId === ctx.otterId) {
      return errorResponse("[错误] 不能 halt 自己。需要中断自己的执行请直接收尾（stop 当前动作、汇报、yield）。");
    }

    const now = new Date().toISOString();
    const signalId = crypto.randomUUID();
    const directive: HaltDirective = {
      id: signalId,
      targetOtterId: target.otterId,
      fromOtterId: ctx.otterId,
      fromOtterName: target.fromOtterName,
      conversationId: ctx.conversationId,
      reason: reason.trim(),
      issuedAt: now,
    };

    haltRegistry.mark(directive);

    // 落账（同步等待——台账是 halt 的审计面，失败要让调用方知道）
    try {
      await signalRepo.create(buildHaltSignalEvent({
        signalId, conversationId: ctx.conversationId, messageId: ctx.currentMessageId,
        fromOtterId: ctx.otterId, targetOtterId: target.otterId, reason: reason.trim(), now,
      }));
    } catch (err) {
      logger?.error('Failed to persist halt signal event', err instanceof Error ? err : new Error(String(err)));
      // 打标已生效（内存态），落账失败不回滚——审计缺一条比刹车失灵好
      return textResponse(`[halt] 已对 ${target.otterName}（${target.otterId}）发出 halt，但台账落库失败：${err instanceof Error ? err.message : String(err)}。刹车已生效，请留意台账数据。`);
    }

    return textResponse(
      `[halt] 已对 ${target.otterName}（${target.otterId}）发出停手指令（台账 ${signalId}）。\n` +
      `它会在下一个工具调用边界收到指令并停下（正在执行中的调用不打断）。最坏延迟 = 单个工具调用时长。\n` +
      `停手报告将随其 yield 返回。`,
    );
  };
  return {
    name: "halt_otter",
    description: "对运行中的小獭发出停手指令（halt）. When: 发现派工方向错误/需求变更/需要中止当前工作但不想丢上下文（restart 是核弹，halt 是刹车）. Not for: 停自己（直接收尾即可）/ 对搭档（无意义）. Output: 打标确认 + 台账 ID. 语义: 目标獭在下一个工具调用边界收到指令，收尾当前调用后停止新增副作用，报告进度快照并 yield 回你. 上下文完整保留，改派后可续干. GOTCHA: 打标后最坏延迟=单个工具调用时长（如长 bash），期间 UI 显示 halt 待生效.",
    parameters: {
      type: "object",
      properties: {
        otterId: { type: "string", description: "目标海獭 ID（与 otterName 二选一）" },
        otterName: { type: "string", description: "目标海獭名称（与 otterId 二选一，按在场参与者解析）" },
        reason: { type: "string", description: "停手理由（必填，写入台账，目标獭在 block 消息中可见——写清改派方向或中止原因，它报告进度时会带上）" },
      },
      required: ["reason"],
    },
    execute: exec,
  };
}

/** query_signals：台账查询（C1 只读；大獭复盘 + UI 前的对话内查证） */
export function createQuerySignalsTool(ctx: ToolContext, signalRepo: SignalEventRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const filter: SignalQueryFilter = {};
    const type = params.type as string | undefined;
    if (type === 'objection' || type === 'blocked' || type === 'halt') filter.type = type as SignalType;
    const status = params.status as string | undefined;
    if (status === 'pending' || status === 'resolved' || status === 'dismissed') filter.status = status as SignalQueryFilter['status'];
    if (params.fromOtterId) filter.fromOtterId = params.fromOtterId as string;
    if (params.targetOtterId) filter.targetOtterId = params.targetOtterId as string;

    const events = await signalRepo.findByConversation(ctx.conversationId, filter, (params.limit as number) ?? 30);
    if (events.length === 0) return textResponse("（无匹配信号记录）");
    const lines = events.map(e =>
      `[${e.id.slice(0, 8)}] ${e.type} · ${e.severity} · ${e.status}\n` +
      `  发起: ${e.fromOtterId}${e.targetOtterId ? ` → 目标: ${e.targetOtterId}` : ''} · ${e.createdAt}\n` +
      `  正文: ${e.payload.length > 200 ? e.payload.slice(0, 200) + '…' : e.payload}` +
      (e.resolution ? `\n  处置: ${e.resolution}` : ''),
    );
    return textResponse(`signal_events（${events.length} 条）：\n${lines.join('\n')}`);
  };
  return {
    name: "query_signals",
    description: "查询本对话的獭间信号台账（halt/objection/blocked）. When: 复盘谁在何时停了谁 / 查悬置异议 / 查 blocked 记录. Output: 信号列表（类型/状态/发起者/目标/正文摘要）.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["objection", "blocked", "halt"], description: "按类型筛选" },
        status: { type: "string", enum: ["pending", "resolved", "dismissed"], description: "按状态筛选" },
        fromOtterId: { type: "string", description: "按发起者筛选" },
        targetOtterId: { type: "string", description: "按目标筛选" },
        limit: { type: "number", description: "返回条数上限（默认 30）" },
      },
    },
    execute: exec,
  };
}
