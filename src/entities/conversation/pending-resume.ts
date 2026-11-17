/**
 * F20260916b1ea：重启自动恢复队列实体（restart_pending_resumes 表）。
 * 8/28 同名机制（messages 模型，message_id 锚点）被 #886 误删后
 * 按 invoke 模型重建——invoke_id 为 PK 锚点（中断真相源）。
 */

export type ResumePendingStatus = "pending" | "done" | "failed" | "exhausted";

export interface PendingResume {
  /** 被中断的 invoke id（锚点即真相源；originalInvokeId——跨恢复世代不变） */
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
  /** F20261116actlg PR-B：认领令牌（认领窗口持有者标识；未认领为 null） */
  claimToken: string | null;
  /** F20261116actlg PR-B：认领时的进程 boot 纪元——旧纪元残留认领可被新开机重认领
   *  （恢复者自身崩溃不留死锁）；同 boot 内拒绝重认领（防双窗口双跑） */
  bootEpoch: number | null;
  /** F20261117 检视轮可优化项 S3：认领进程 pid——重认领前 liveness 预检
   *  （旧持有者仍存活则不抢防双跑；已死/NULL 才允许重认领） */
  claimPid: number | null;
  /** F20261116actlg PR-B：本恢复轮点火的 invoke id（审计链：原 invoke 为 PK 不变，
   *  此列追加式记录每一轮的恢复 invoke，多次恢复全历史不丢） */
  recoveryInvokeId: string | null;
}
