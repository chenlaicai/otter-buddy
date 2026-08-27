/**
 * Healing 相关工具：系统自愈报告解析和 healing event 管理。
 */

import type { HealingEventRepository, HealingEventBatchFilter } from "@usecases/healing/healing-event-repository";
import type { HealingResolutionAction, HealingEventStatus, HealingErrorType } from "@entities/healing/healing-event";
import { parseHealingReport, stripHealingReport } from "@usecases/healing/healing-report-parser";
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import type { Logger } from "@usecases/ports/logger";
import type { ToolContext, AgentTool, ToolResponse } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

/** 解析并剥离 healing report，返回清理后的 body */
export function interceptHealingReport(rawBody: string, ctx: ToolContext, repo: HealingEventRepository, logger?: Logger): string {
  const cleanBody = stripHealingReport(rawBody);
  const { hasIssues, issues } = parseHealingReport(rawBody);
  if (hasIssues) {
    const now = new Date().toISOString();
    const meta = { otterId: ctx.otterId, conversationId: ctx.conversationId, messageId: ctx.currentMessageId };
    for (const issue of issues) {
      if (issue.severity === 'high') {
        logger?.warn('High severity healing event', { type: issue.type, description: issue.description });
        // F20260826mwrd C3（Part 4）：high 事件不再止步于日志——登记待提醒，
        // 大獭下一次 invoke 的 dynamicContext 注入（台账照旧落 healing_events）。
        // 键用 conversationId（对话粒度队列）：消费侧（agent-invoker）按对话取全部，
        // 大獭不在场则滞留到下一轮，不丢。eventId 先行生成、与台账 create 同源
        // （fire-and-forget 双写各自失败不阻塞对方，审计面以 healing_events 为准）。
        healingAlertRegistry.enqueue(ctx.conversationId, {
          eventId: crypto.randomUUID(),
          conversationId: ctx.conversationId,
          otterId: ctx.otterId,
          errorType: issue.type,
          description: issue.description,
          createdAt: now,
        });
      }
      repo.create({
        id: crypto.randomUUID(), messageId: ctx.currentMessageId, conversationId: ctx.conversationId,
        otterId: ctx.otterId, errorType: issue.type, severity: issue.severity,
        description: issue.description, suggestion: issue.suggestion,
        context: meta, status: 'open', resolution: null, createdAt: now, resolvedAt: null,
      }).catch(err => logger?.error('Failed to store healing event', err instanceof Error ? err : new Error(String(err))));
    }
  }
  return cleanBody;
}

/** ISO 8601 日期校验——非法格式静默参与字典序比较会语义意外（检视獭-454 发现 3） */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Why: Date.parse 对宽松格式（如 "2026-8-1"）也返回有效值，用正则锁定 yyyy-MM-ddTHH:mm:ss 格式
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?$/.test(value) && !isNaN(Date.parse(value));
}

/** 创建 healing event 管理工具 */
async function handleBatchResolve(
  params: Record<string, unknown>,
  healingRepo: HealingEventRepository,
): Promise<ToolResponse> {
  // Why: 日期参数格式校验——非法输入会静默参与字典序比较导致语义意外
  for (const key of ['filterCreatedBefore', 'filterCreatedAfter']) {
    const val = params[key];
    if (val !== undefined && !isValidIsoTimestamp(val)) {
      return errorResponse(`[错误] ${key} 必须是 ISO 8601 时间戳（如 2026-08-25T00:00:00Z），收到：${val}`);
    }
  }
  const filter: HealingEventBatchFilter = {
    status: (params.filterStatus as string as HealingEventStatus) ?? 'open',
    errorType: params.filterErrorType as HealingErrorType | undefined,
    createdBefore: params.filterCreatedBefore as string | undefined,
    createdAfter: params.filterCreatedAfter as string | undefined,
  };
  const resolution = {
    action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction,
    decidedBy: 'agent' as const,
    decidedAt: new Date().toISOString(),
    notes: (params.resolutionNotes as string) ?? '',
  };
  const dryRun = (params.dryRun as boolean) ?? false;

  if (dryRun) {
    const result = await healingRepo.batchResolveByFilter(filter, resolution, { dryRun: true });
    return textResponse(JSON.stringify({ dryRun: true, matched: result.matched }, null, 2));
  }

  const result = await healingRepo.batchResolveByFilter(filter, resolution, { limit: 100 });
  return textResponse(JSON.stringify({
    matched: result.matched, resolved: result.resolved,
    resolvedIds: result.resolvedIds, resolutionNotes: resolution.notes,
    // Why: truncated 让 LLM 知道还有剩余未处置，需再次执行
    truncated: result.truncated, totalMatched: result.totalMatched,
  }, null, 2));
}

/** 创建 healing event 管理工具 */
export function createManageHealingEventsTool(ctx: ToolContext, healingRepo: HealingEventRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ToolResponse> => {
    const action = params.action as string;
    if (action === 'query') {
      const status = (params.status as string) ?? 'open';
      let events = await healingRepo.findAll(status as 'open' | 'resolved' | 'dismissed', 50);
      const et = params.errorType as string | undefined;
      if (et) events = events.filter(e => e.errorType === et);
      return textResponse(JSON.stringify(events, null, 2));
    }
    if (action === 'batch_resolve') return handleBatchResolve(params, healingRepo);
    const ids = params.eventIds as string[];
    if (!ids?.length) return errorResponse("[错误] eventIds 不能为空");
    if (action === 'resolve' || action === 'dismiss') {
      const fn = action === 'resolve'
        ? (id: string) => healingRepo.resolve(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' })
        : (id: string) => healingRepo.updateStatus(id, 'dismissed');
      const res = await Promise.allSettled(ids.map(fn));
      const succeeded = res.filter(r => r.status === 'fulfilled').length;
      if (succeeded < ids.length) {
        const failedReasons = res
          .map((r, i) => r.status === 'rejected' ? `${ids[i]}: ${(r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)}` : null)
          .filter(Boolean)
          .join('; ');
        return errorResponse(`[错误] 部分失败：${succeeded}/${ids.length} 成功。失败原因：${failedReasons}`);
      }
      return textResponse(`完成: ${succeeded}/${ids.length} 成功`);
    }
    return errorResponse(`[错误] 未知操作: ${action}。支持的操作：query / resolve / dismiss / batch_resolve。`);
  };
  return {
    name: "manage_healing_events",
    description: "查询和管理 healing events（系统自愈问题记录）. When: 查看自愈检测到的问题 / 标记已解决或忽略. Not for: 主动注入 healing 标记 → 走 speak 的 healing 块. Output: 问题列表或处置确认（action: query/resolve/dismiss/batch_resolve）. batch_resolve: 按 filter 批量处置（用 filterStatus/filterErrorType/filterCreatedBefore/filterCreatedAfter 替代 eventIds），单批上限 100，建议先 dryRun 预览再真实执行；响应含 truncated=true 时需再次执行处理剩余批次. GOTCHA: resolve/dismiss 部分失败时返回 isError——需检查响应中失败计数.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["query", "resolve", "dismiss", "batch_resolve"], description: "操作类型" },
        status: { type: "string", enum: ["open", "resolved", "dismissed"], description: "按状态筛选" },
        errorType: { type: "string", description: "按错误类型筛选" },
        eventIds: { type: "array", items: { type: "string" }, description: "event ID 列表" },
        resolutionAction: { type: "string", enum: ["prompt_updated", "memory_added", "tool_fixed", "config_changed", "no_action", "deferred"], description: "修复行动" },
        resolutionNotes: { type: "string", description: "解决方式说明" },
        filterStatus: { type: "string", enum: ["open", "resolved", "dismissed"], description: "[batch_resolve] 按状态筛选，默认 open" },
        filterErrorType: { type: "string", description: "[batch_resolve] 按错误类型筛选" },
        filterCreatedBefore: { type: "string", description: "[batch_resolve] ISO 时间戳，筛选 created_at < 此值的事件" },
        filterCreatedAfter: { type: "string", description: "[batch_resolve] ISO 时间戳，筛选 created_at > 此值的事件" },
        dryRun: { type: "boolean", description: "[batch_resolve] true 时只返回匹配事件数，不执行 resolve" },
      },
      required: ["action"],
    },
    execute: exec,
  };
}
