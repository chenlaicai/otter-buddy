import type { PendingResume, ResumePendingStatus } from "@entities/conversation/pending-resume";

/**
 * F20260916b1ea：重启自动恢复队列仓库（restart_pending_resumes 表）。
 *
 * 三保障承载体：
 * - 原子 claim（claimPendingResume 的 CAS 自增——多重启窗口防重复恢复）
 * - crash-resilience（pending 状态跨重启持久，恢复流程自身崩溃可重拾）
 * - attempts 上限（updateResumeStatus 到 exhausted，防配额耗尽型 429 无限重试）
 */
export interface ResumePendingRepository {
  /** 取全部 pending 队列项（恢复服务消费入口） */
  getPendingResumes(): Promise<PendingResume[]>;
  /** 信号补扫的会话范围数据源：启动前（beforeTimestamp 之前）有 invoke 点火痕迹的
   *  会话集合（invokes.started_at 或 invoke_start entry——崩溃窗口内「entry 落库但
   *  invoke 没建成」的纯信号场景必在其列）。与中断队列的会话集合取并集后逐会话补扫。 */
  listRecentConversationIds(beforeTimestamp: string): Promise<string[]>;
  /** 原子认领：status='pending' 时 attempts+1；changes=0（已被认领/终态）返回 false */
  claimPendingResume(invokeId: string): Promise<boolean>;
  /** 流转状态到终态（done/failed/exhausted），写 settled_at */
  settleResume(
    invokeId: string,
    status: ResumePendingStatus,
    settledAt: string,
  ): Promise<void>;
}
