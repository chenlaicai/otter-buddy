import type { ScheduledTaskRepository } from '@usecases/scheduled-task/scheduled-task-repository';
import type { ScheduledTaskPendingItemRepository, ScheduledTaskPendingListItem } from './pending-item-repository';

export type PendingDetailResult =
  | { kind: 'detail'; item: ScheduledTaskPendingListItem; body: string; description: string | null }
  | { kind: 'covered'; item: ScheduledTaskPendingListItem };

/** 獭侧待执行列表读/销账；补执行本身仍由獭走正常发言与工具流程。 */
export class ManageScheduledTaskPending {
  constructor(
    private readonly pendingRepo: ScheduledTaskPendingItemRepository,
    private readonly taskRepo: ScheduledTaskRepository,
  ) {}

  list(conversationId: string, role: string): Promise<ScheduledTaskPendingListItem[]> {
    return this.pendingRepo.list(conversationId, role);
  }

  async detail(id: string, conversationId: string, role: string): Promise<PendingDetailResult | null> {
    const item = await this.pendingRepo.getById(id, conversationId);
    if (!item || item.role !== role) return null;
    if (await this.isAlreadyCovered(item)) return { kind: 'covered', item };
    const task = await this.taskRepo.getById(item.taskId);
    if (!task) return null;
    return { kind: 'detail', item, body: task.body, description: task.description };
  }

  async ack(input: {
    id: string;
    conversationId: string;
    role: string;
    resolution: 'executed' | 'skipped';
    reason: string;
  }): Promise<{ kind: 'acked' | 'covered' | 'not-found' }> {
    const item = await this.pendingRepo.getById(input.id, input.conversationId);
    if (!item || item.role !== input.role) return { kind: 'not-found' };
    const covered = await this.isAlreadyCovered(item);
    const consumed = await this.pendingRepo.consume({
      id: item.id,
      conversationId: item.conversationId,
      role: item.role,
      resolution: input.resolution,
      reason: covered ? `本轮已直发覆盖；${input.reason.trim()}` : input.reason.trim(),
      consumedAt: new Date().toISOString(),
    });
    if (!consumed) return { kind: 'not-found' };
    return { kind: covered ? 'covered' : 'acked' };
  }

  /** 双跑残留缝兜底：拉详情/销账前重新对账，不信入列时的旧状态。 */
  private isAlreadyCovered(item: ScheduledTaskPendingListItem): Promise<boolean> {
    return this.pendingRepo.hasDirectCompletionInSlot(item.taskId, item.triggeredAt);
  }
}
