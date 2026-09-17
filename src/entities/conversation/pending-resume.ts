/**
 * F20260916b1ea：重启自动恢复队列实体（restart_pending_resumes 表）。
 * 8/28 同名机制（messages 模型，message_id 锚点）被 #886 误删后
 * 按 invoke 模型重建——invoke_id 为 PK 锚点（中断真相源）。
 */

export type ResumePendingStatus = "pending" | "done" | "failed" | "exhausted";

export interface PendingResume {
  /** 被中断的 invoke id（锚点即真相源） */
  invokeId: string;
  conversationId: string;
  otterId: string;
  /** 触发 entry（续跑记账用；可为 NULL——scheduler 直调路径，F20260917rscr 裁决①后同样入队） */
  triggerEntryId: string | null;
  status: ResumePendingStatus;
  /** 恢复尝试计数（CAS 认领自增；防无限重试——配额耗尽型 429 上限 #843 实证） */
  attempts: number;
  createdAt: string;
  settledAt: string | null;
}
