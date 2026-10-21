import type { AgentTool, ToolContext, ToolResponse } from '@usecases/ports/agent-tools';
import { textResponse, errorResponse } from '@usecases/ports/agent-tools';
import type { ManageScheduledTaskPending } from '@usecases/scheduler/manage-scheduled-task-pending';

async function listPending(ctx: ToolContext, pending: ManageScheduledTaskPending, role: string): Promise<ToolResponse> {
  const items = await pending.list(ctx.conversationId, role);
  return textResponse(JSON.stringify(items.map(item => ({
    pendingId: item.id, taskId: item.taskId, taskName: item.taskName,
    triggeredAt: item.triggeredAt, role: item.role,
  }))));
}

async function detailPending(ctx: ToolContext, pending: ManageScheduledTaskPending, role: string, params: Record<string, unknown>): Promise<ToolResponse> {
  const pendingId = typeof params.pendingId === 'string' ? params.pendingId : '';
  if (!pendingId) return errorResponse('[错误] detail 需要 pendingId');
  const result = await pending.detail(pendingId, ctx.conversationId, role);
  if (!result) return errorResponse('[错误] pending 不存在、已销账或不属于当前角色');
  if (result.kind === 'covered') {
    return textResponse(JSON.stringify({ covered: true, message: '本轮已直发覆盖，无需补执行；请用 ack 销账', item: result.item }));
  }
  return textResponse(JSON.stringify(result));
}

async function ackPending(ctx: ToolContext, pending: ManageScheduledTaskPending, role: string, params: Record<string, unknown>): Promise<ToolResponse> {
  const pendingId = typeof params.pendingId === 'string' ? params.pendingId : '';
  const resolution = params.resolution;
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (!pendingId) return errorResponse('[错误] ack 需要 pendingId');
  if (resolution !== 'executed' && resolution !== 'skipped') return errorResponse('[错误] ack 需要 resolution=executed|skipped');
  if (!reason) return errorResponse('[错误] ack 需要一句话 reason');
  const result = await pending.ack({ id: pendingId, conversationId: ctx.conversationId, role, resolution, reason });
  if (result.kind === 'not-found') return errorResponse('[错误] pending 不存在、已销账或不属于当前角色');
  return textResponse(JSON.stringify(result));
}

export function createManageScheduledTaskPendingTool(ctx: ToolContext, pending: ManageScheduledTaskPending): AgentTool {
  return {
    name: 'manage_scheduled_task_pending',
    description: '管理本对话的定时任务待执行列表. When: 提醒显示有 pending，需查看任务并决定补执行或跳过. Not for: 创建/修改定时任务 → create_scheduled_task；让工具代办执行（ack 只销账）. Output: list=任务名/触发时间/pending id；detail=任务全文；ack=处置回执. GOTCHA: detail/ack 会重查同 cron 槽位 completed，已直发覆盖时不要重复补执行；ack 必须带 resolution=executed|skipped 和一句话理由. BOUNDARY: 仅当前角色名下的 pending，ack 后不再提醒.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'detail', 'ack'], description: 'list=轻量列表；detail=拉取单条全文；ack=处置后销账' },
        pendingId: { type: 'string', description: 'detail/ack 必填，来自 list 的 pending id' },
        resolution: { type: 'string', enum: ['executed', 'skipped'], description: 'ack 必填：已补执行或决定跳过' },
        reason: { type: 'string', description: 'ack 必填：一句话说明处置依据（执行结果或跳过原因）' },
      },
      required: ['action'],
    },
    execute: async (_id: string, params: Record<string, unknown>): Promise<ToolResponse> => {
      try {
        const role = (await ctx.client.otter.getById(ctx.otterId))?.name;
        if (!role) return errorResponse('[错误] 无法确认当前獭角色，拒绝操作 pending 列表');
        if (params.action === 'list') return listPending(ctx, pending, role);
        if (params.action === 'detail') return detailPending(ctx, pending, role, params);
        if (params.action === 'ack') return ackPending(ctx, pending, role, params);
        return errorResponse('[错误] action 必须是 list/detail/ack');
      } catch (error) {
        return errorResponse(`[错误] 操作定时任务待执行列表失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
