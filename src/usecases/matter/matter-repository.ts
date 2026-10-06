import type { Matter, MatterQueryFilter } from '@entities/matter/matter';

/**
 * Matter 持久化仓库接口（F20261005mtlp P1）。
 *
 * 写路径：RegisterMatter（准入白名单三条）+ TransitionMatter（状态迁移单入口）。
 * 读路径：①右侧栏「待办」tab（只读 API）②restart 机械供料（handoff_open_matters）
 *        ③獭侧 list_matters 工具。
 * 每列消费方声明见方案 §1 ⑥纪律。
 */

export interface MatterRepository {
  create(matter: Matter): Promise<void>;
  findById(id: string): Promise<Matter | null>;
  /** 按对话查询（可选 state/openOnly/owner/waitingOn 过滤），created_at 倒序 */
  findByConversation(conversationId: string, filter?: MatterQueryFilter, limit?: number): Promise<Matter[]>;
  /**
   * 状态迁移写路径（单入口的物理落点）：
   * 条件更新（WHERE state = ?）——并发迁移只有一方成功，另一方读到 changes=0
   * 走幂等/冲突语义（与 SqliteSignalEventRepository.resolve 同模式）。
   * @returns 更新后的实体；id 不存在或状态已迁走返回 null（乐观锁防重）
   */
  transition(
    id: string,
    fromState: Matter['state'],
    patch: Partial<Pick<Matter, 'state' | 'waitingOn' | 'waitingFor' | 'payload' | 'resolution' | 'resolvedBy' | 'ownerOtterId' | 'level'>> & { updatedAt: string; closedAt?: string | null },
  ): Promise<Matter | null>;
  /**
   * 等待方消亡规则（§2 等待方生命周期规则①）：owner 獭被解散 →
   * 其名下 WAITING_OTTER 的 matter 自动转回 OPEN 待重派（每日扫描兜底）。
   */
  reopenForDissolvedOwner(otterId: string, now: string): Promise<number>;
}
