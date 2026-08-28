/**
 * Signal event 持久化仓库接口（F20260826mwrd C1）。
 *
 * 写路径：halt_otter 工具调用（C1）；signal-parser 拦截（C2）。
 * 读路径：halt 查询工具（C1 大獭侧）；裁决工具（C2）；UI DTO（C4）。
 * 每列消费方声明见 F20260826mwrd.md「新增 schema 字段消费方声明」。
 */

import type { SignalEvent, SignalQueryFilter } from '@entities/signal/signal-event';

export interface SignalEventRepository {
  create(event: SignalEvent): Promise<void>;
  findById(id: string): Promise<SignalEvent | null>;
  /** 按对话查询（可选 type/status/from/to 过滤），created_at 倒序 */
  findByConversation(conversationId: string, filter?: SignalQueryFilter, limit?: number): Promise<SignalEvent[]>;
  /** 按消息 ID 批量查询（C4 UI DTO 挂载用），message_id 分组，组内 created_at 升序（与剥离前原文顺序一致） */
  findByMessageIds(messageIds: string[]): Promise<SignalEvent[]>;
  /**
   * 裁决写路径（F20260826mwrd 审视发现 2 的代码落点）：
   * resolve_signal 工具调用此方法落库，状态迁移以本方法为唯一数据源。
   * @returns 更新后的实体；id 不存在或已非 pending 返回 null（幂等防重）
   */
  resolve(id: string, status: 'resolved' | 'dismissed', resolution: string, resolvedBy: string): Promise<SignalEvent | null>;
}
