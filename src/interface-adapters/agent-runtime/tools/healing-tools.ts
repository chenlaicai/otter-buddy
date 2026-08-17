/**
 * Healing 相关工具：系统自愈报告解析和 healing event 管理。
 */

import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingResolutionAction } from "@entities/healing/healing-event";
import { parseHealingReport, stripHealingReport } from "@usecases/healing/healing-report-parser";
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
      if (issue.severity === 'high') logger?.warn('High severity healing event', { type: issue.type, description: issue.description });
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
    const ids = params.eventIds as string[];
    if (!ids?.length) return errorResponse("[错误] eventIds 不能为空");
    if (action === 'resolve' || action === 'dismiss') {
      const fn = action === 'resolve'
        ? (id: string) => healingRepo.resolve(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' })
        : (id: string) => healingRepo.updateStatus(id, 'dismissed');
      const res = await Promise.allSettled(ids.map(fn));
      const succeeded = res.filter(r => r.status === 'fulfilled').length;
      /** F20260811sktp 第三轮审视：部分失败时设 isError=true，让 LLM 结构化识别重试失败的那些 */
      if (succeeded < ids.length) {
        const failedReasons = res
          .map((r, i) => r.status === 'rejected' ? `${ids[i]}: ${(r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)}` : null)
          .filter(Boolean)
          .join('; ');
        return errorResponse(`[错误] 部分失败：${succeeded}/${ids.length} 成功。失败原因：${failedReasons}`);
      }
      return textResponse(`完成: ${succeeded}/${ids.length} 成功`);
    }
    return errorResponse(`[错误] 未知操作: ${action}。支持的操作：query / resolve / dismiss。`);
  };
  return {
    name: "manage_healing_events",
    description: "查询和管理 healing events（系统自愈问题记录）. When: 查看自愈检测到的问题 / 标记已解决或忽略. Not for: 主动注入 healing 标记 → 走 speak 的 healing 块. Output: 问题列表或处置确认（action: query/resolve/dismiss）. GOTCHA: 批量 resolve/dismiss 部分失败时返回 isError——需检查响应中失败计数.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["query", "resolve", "dismiss"], description: "操作类型" },
        status: { type: "string", enum: ["open", "resolved", "dismissed"], description: "按状态筛选" },
        errorType: { type: "string", description: "按错误类型筛选" },
        eventIds: { type: "array", items: { type: "string" }, description: "event ID 列表" },
        resolutionAction: { type: "string", enum: ["prompt_updated", "memory_added", "tool_fixed", "config_changed", "no_action", "deferred"], description: "修复行动" },
        resolutionNotes: { type: "string", description: "解决方式说明" },
      },
      required: ["action"],
    },
    execute: exec,
  };
}
