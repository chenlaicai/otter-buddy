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
import { parseSignalReport, stripSignalReport } from "@usecases/signal/signal-report-parser";
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
      `它会在下一个非 speak 工具调用边界收到指令并停下（正在执行中的调用不打断；speak 豁免——它可用 speak 报告进度快照）。最坏延迟 = 单个工具调用时长。\n` +
      `停手报告将随其 yield 返回。`,
    );
  };
  return {
    name: "halt_otter",
    description: "对运行中的小獭发出停手指令（halt）. When: 发现派工方向错误/需求变更/需要中止当前工作但不想丢上下文（restart 是核弹，halt 是刹车）. Not for: 停自己（直接收尾即可）/ 对搭档（无意义）. Output: 打标确认 + 台账 ID. 语义: 目标獭在下一个非 speak 工具调用边界收到指令（speak 豁免供报告进度），收尾当前调用后停止新增副作用，报告进度快照并交回行动权. 上下文完整保留，改派后可续干. GOTCHA: 打标后最坏延迟=单个工具调用时长（如长 bash），期间 UI 显示 halt 待生效.",
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

/**
 * F20260826mwrd C2：speak 入口信号拦截（仿 interceptHealingReport 先例）。
 * 解析 <signal> 块 → signal_events 落账（fire-and-forget，不阻断发言）→ 返剥离后 cleanBody。
 * halt 类型不经此路（只能经 halt_otter 工具，type 白名单不含 halt）。
 */
export async function interceptSignalReport(
  rawBody: string,
  ctx: ToolContext,
  repo: SignalEventRepository,
  logger?: Logger,
): Promise<string> {
  const cleanBody = stripSignalReport(rawBody);
  const { signals } = parseSignalReport(rawBody);
  if (signals.length > 0) {
    const now = new Date().toISOString();
    for (const sig of signals) {
      const event: SignalEvent = {
        id: crypto.randomUUID(),
        conversationId: ctx.conversationId,
        messageId: ctx.currentMessageId,
        fromOtterId: ctx.otterId,
        targetOtterId: null,
        type: sig.type,
        severity: sig.severity,
        payload: sig.payload,
        status: 'pending',
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: now,
      };
      // fire-and-forget：信号落库失败不阻断发言（台账是审计面，不是发言前置条件）
      repo.create(event).catch(err =>
        logger?.error('Failed to persist signal event', err instanceof Error ? err : new Error(String(err))),
      );
    }
  }
  return cleanBody;
}

/** 短 ID 解析：非完整 UUID 时前缀匹配本对话 pending 信号（query_signals 回显为短 ID）。只搜 pending——已裁决信号有幂等路径，无需短 ID 再次触达 */
async function resolveSignalId(
  ctx: ToolContext,
  signalRepo: SignalEventRepository,
  signalId: string,
): Promise<{ id: string } | { error: string }> {
  const fullId = signalId.trim();
  if (/^[0-9a-f]{8}-/i.test(fullId)) return { id: fullId };
  const candidates = await signalRepo.findByConversation(ctx.conversationId, { status: 'pending' }, 50);
  const hit = candidates.filter(e => e.id.startsWith(fullId));
  if (hit.length === 0) {
    return { error: `前缀「${fullId}」在本对话 pending 信号中无匹配。用 query_signals(status=pending) 确认 ID。` };
  }
  if (hit.length > 1) {
    return { error: `前缀「${fullId}」命中 ${hit.length} 条，请用完整 ID。` };
  }
  return { id: hit[0].id };
}

/** 存在性/跨对话/幂等三重校验，拆出控制主函数复杂度 */
async function checkResolvable(
  ctx: ToolContext,
  signalRepo: SignalEventRepository,
  id: string,
): Promise<{ event: SignalEvent } | { error: string } | { idempotent: string }> {
  const existing = await signalRepo.findById(id);
  if (!existing) {
    return { error: `[错误] 信号 ${id} 不存在。用 query_signals 确认。` };
  }
  // 跨对话越权裁决拒绝（防御纵深：同 conversation 才允许）
  if (existing.conversationId !== ctx.conversationId) {
    return { error: "[错误] 该信号不属于当前对话，拒绝裁决。" };
  }
  if (existing.status !== 'pending') {
    return {
      idempotent: `[幂等] 信号 ${existing.id} 已是 ${existing.status}（resolvedBy=${existing.resolvedBy}），无需重复裁决。原处置：${existing.resolution ?? '（无）'}`,
    };
  }
  return { event: existing };
}

/**
 * F20260826mwrd C2：resolve_signal 裁决工具（big 专用）。
 * 「程序化裁决义务」的代码落点：裁决 = 本工具调用落库，speak 里的裁决文本仅作展示。
 * 状态迁移以此为唯一数据源（UI 徽章 resolved/dismissed 渲染同源）。
 */
export function createResolveSignalTool(ctx: ToolContext, signalRepo: SignalEventRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const signalId = params.signalId as string | undefined;
    const status = params.status as string | undefined;
    const resolution = (params.resolution as string | undefined) ?? '';

    if (!signalId || !signalId.trim()) {
      return errorResponse("[错误] signalId 必填——用 query_signals(status=pending) 查台账拿 ID（回显为短 ID）。");
    }
    if (status !== 'resolved' && status !== 'dismissed') {
      return errorResponse("[错误] status 必须是 resolved（采纳/已处理）或 dismissed（驳回）。");
    }
    if (!resolution.trim()) {
      return errorResponse("[错误] resolution 必填——裁决理由是台账的一部分（驳回写为何驳、采纳写怎么改派），空裁决等于没裁决。");
    }

    const resolved = await resolveSignalId(ctx, signalRepo, signalId);
    if ('error' in resolved) return errorResponse(`[错误] ${resolved.error}`);

    const verdict = await checkResolvable(ctx, signalRepo, resolved.id);
    if ('error' in verdict) return errorResponse(verdict.error);
    if ('idempotent' in verdict) return textResponse(verdict.idempotent);

    const updated = await signalRepo.resolve(resolved.id, status, resolution.trim(), ctx.otterId);
    if (!updated) {
      return errorResponse(`[错误] 裁决落库失败（信号 ${resolved.id}）。请重试或查日志。`);
    }
    return textResponse(
      `[裁决完成] 信号 ${resolved.id}（${verdict.event.type}）→ ${status}。理由：${resolution.trim()}`,
    );
  };
  return {
    name: "resolve_signal",
    description: "裁决一条獭间信号（objection/blocked）. When: 小獭发了 <signal> 异议或 blocked 信号后，你（大獭）必须显式裁决——采纳/resolved 或驳回/dismissed，不得悬置. Not for: halt 信号（系统自动落账 resolved，无需裁决）/ 查询（用 query_signals）. Output: 裁决确认（状态迁移 + 台账留痕）. GOTCHA: 裁决必须带理由（resolution），空裁决等于没裁决；ID 支持 query_signals 回显的短 ID（前 8 位）.",
    parameters: {
      type: "object",
      properties: {
        signalId: { type: "string", description: "信号 ID（query_signals 回显的短 ID 或完整 UUID）" },
        status: { type: "string", enum: ["resolved", "dismissed"], description: "resolved=采纳/已处理；dismissed=驳回（写明为何驳）" },
        resolution: { type: "string", description: "裁决理由（必填）：驳回写为何驳（如'当时否的是全量迁移，本次只迁搜索路径'）；采纳写怎么处理（改派/给资源/砍需求）" },
      },
      required: ["signalId", "status", "resolution"],
    },
    execute: exec,
  };
}
