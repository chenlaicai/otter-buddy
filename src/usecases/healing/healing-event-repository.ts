import type { HealingEvent, HealingEventStats, HealingEventStatus, HealingResolution } from '@entities/healing/healing-event';

/** Healing event 持久化仓库接口 */
export interface HealingEventRepository {
  create(event: HealingEvent): Promise<void>;
  findById(id: string): Promise<HealingEvent | null>;
  findOpen(limit?: number): Promise<HealingEvent[]>;
  findAll(status: HealingEventStatus, limit?: number): Promise<HealingEvent[]>;
  findByConversation(conversationId: string): Promise<HealingEvent[]>;
  updateStatus(id: string, status: HealingEventStatus): Promise<void>;
  resolve(id: string, resolution: HealingResolution): Promise<void>;
  getStats(): Promise<HealingEventStats>;
  /** 自动清理：dismiss 超过 N 天未更新的 open 事件 */
  autoStaleDismiss(staleDays: number): Promise<number>;
}
