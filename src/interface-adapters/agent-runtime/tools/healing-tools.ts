/**
 * Healing 相关工具：系统自愈报告解析和 healing event 管理。
 */

import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingResolutionAction } from "@entities/healing/healing-event";
import { parseHealingReport, stripHealingReport } from "@usecases/healing/healing-report-parser";
import type { Logger } from "@usecases/ports/logger";
import type { ToolContext, AgentTool } from "./tool-factory";
import { type ToolResponse, textResponse } from "./tool-helpers";

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
    if (!ids?.length) return textResponse("[错误] eventIds 不能为空");
    if (action === 'resolve' || action === 'dismiss') {
      const fn = action === 'resolve'
        ? (id: string) => healingRepo.resolve(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' })
        : (id: string) => healingRepo.updateStatus(id, 'dismissed');
      const res = await Promise.allSettled(ids.map(fn));
      return textResponse(`完成: ${res.filter(r => r.status === 'fulfilled').length}/${ids.length} 成功`);
    }
    return textResponse(`未知操作: ${action}`);
  };
  return {
    name: "manage_healing_events",
    description: "查询和管理 healing events（系统自愈问题记录）。查看待处理问题、标记已解决/忽略。",
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
