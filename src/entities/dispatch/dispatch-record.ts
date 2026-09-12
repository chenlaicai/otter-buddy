/**
 * Dispatch record 实体（F20260912avlb）：派工台账。
 *
 * 状态只记系统可客观判定的生命周期事件——created（create_otter 成功，獭就位待命）/
 * dispatched（行动权首次交给该獭）/ dissolved（獭被解散）。
 * 不设 completed/failed 终态：「任务完成」的真相在对话汇报里，无系统可判定信号，
 * 硬造终态 = 新一轮假数据（旧 otter_context 伪存储 470 条记录 469 条 in_progress、
 * 0 条终态的教训，见特性文档「数据层真相」节）。
 *
 * 一条记录 = 一个獭在一个对话的一次生命周期（创建到首派窗口闭合）。
 */

/** 派工记录状态（客观生命周期三态） */
export type DispatchStatus = 'created' | 'dispatched' | 'dissolved';

/** 派工记录实体 */
export interface DispatchRecord {
  id: string;
  conversationId: string;
  otterId: string;
  /** 快照名（创建时的名字，獭可能已不存在） */
  otterName: string;
  /** 任务摘要（systemPrompt 前 200 字符） */
  task: string;
  status: DispatchStatus;
  createdAt: string;
  /** 首次收到行动权的时间（in_progress 存量迁移用原 updatedAt 近似填充） */
  dispatchedAt: string | null;
  /** 獭被解散的时间（存量迁移的历史记录不可知，如实为 NULL） */
  dissolvedAt: string | null;
}

/** findByFilter 过滤条件（全部 AND，全可选） */
export interface DispatchRecordFilter {
  conversationId?: string;
  otterId?: string;
  status?: DispatchStatus;
  limit?: number;
}
