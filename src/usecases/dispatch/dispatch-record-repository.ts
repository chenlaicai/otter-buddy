/**
 * Dispatch record 持久化仓库接口（F20260912avlb）。
 *
 * 写路径：create_otter 钩子（created）；yield 钩子（markDispatched）；
 * dissolve 清算钩子（markDissolved，与 DissolveOtter 既有 4.5/4.6/4.7 清账同模式）。
 * 读路径：query_dispatch_ledger 工具、web 活动页、cost-output 指标（直 SQL）。
 */

import type { DispatchRecord, DispatchRecordFilter } from '@entities/dispatch/dispatch-record';

export interface DispatchRecordRepository {
  create(record: DispatchRecord): Promise<void>;

  /**
   * 批量语义（方案 delta 复审建议 1 显式定义）：该獭在该对话**全部 created 状态记录**
   * 刷为 dispatched（一条记录 = 创建到首派窗口闭合；旧记录不停留在 created）。
   * 只刷 created：已 dispatched 的记录保留首次时间戳，不重复刷新。
   * @returns 更新行数
   */
  markDispatched(otterId: string, conversationId: string): Promise<number>;

  /**
   * 全局清算：该獭全部非 dissolved 记录刷为 dissolved（dissolve 销毁的是獭本体，
   * 全局事件，不分对话）。dissolved_at = 当前时间（存量迁移的历史记录走覆盖路径除外）。
   * @returns 更新行数
   */
  markDissolved(otterId: string): Promise<number>;

  /** 按过滤条件查询，created_at 倒序 */
  findByFilter(filter?: DispatchRecordFilter): Promise<DispatchRecord[]>;

  /**
   * 存量迁移（一次性，事务内）：otter_context `dispatch:%` 伪存储全量搬入本表。
   * 状态映射：pending → created（dispatched_at=NULL）；in_progress → dispatched
   * （dispatched_at 用原 updatedAt 近似填充，cost-output 历史指标不丢）；
   * 再按全局 otters 表 active 集覆盖 dissolved（dissolve_otter 销毁獭本体，
   * participant 名册不可靠，active 集是唯一真相源）。搬完删旧 key（消灭双源）。
   * 幂等由调用侧（migration.ts settings 键）防重跑；本方法自身以「无 dispatch: key
   * 即零循环」天然安全。
   * Why 同步签名：better-sqlite3 全同步，async 只在与 repo 消费方统一接口契约时才需要
   * （migration.ts 启动路径同步调用，无 Promise 装包开销）。
   */
  migrateFromContext(): { migrated: number; ignored: number };
}
