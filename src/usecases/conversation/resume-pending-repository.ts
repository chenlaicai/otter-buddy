import type { PendingResume, ResumePendingStatus } from "@entities/conversation/pending-resume";

/**
 * 重启自动恢复队列仓库（restart_pending_resumes 表）。
 *
 * 三保障承载体：
 * - 原子 claim（claimPendingResume 的 CAS 自增——多重启窗口防重复恢复）
 * - crash-resilience（pending 状态跨重启持久，恢复流程自身崩溃可重拾）
 * - attempts 上限（updateResumeStatus 到 exhausted，防配额耗尽型 429 无限重试）
 */
export interface ResumePendingRepository {
  /** 取全部 pending 队列项（恢复服务消费入口） */
  getPendingResumes(): Promise<PendingResume[]>;
  /** 原子认领（绑定 claim token + boot epoch；F20261117 检视轮 补 pid）：
   *  status='pending' 且 attempts<上限 且（从未认领 或 boot_epoch != 本次纪元）时
   *  attempts+1 并写入 token/epoch/pid；changes=0 返回 false。
   *  同 boot 内已认领拒重认领（防双窗口双跑）；旧纪元残留可重认领（恢复者崩溃不留死锁，
   *  重认领前由服务层做旧持有者 pid liveness 预检——仍存活则不抢）。
   *  只在恢复入口调用一次（attempts 语义 = 跨重启恢复次数，进程内 429 退避不重认领） */
  claimPendingResume(invokeId: string, claim: { token: string; bootEpoch: number; pid: number }): Promise<boolean>;
  /** （F20261117 检视轮 改追加式）：追加本恢复轮点火的 invoke id
   *  到审计链（多次恢复全历史不丢；逗号分隔，attempts 上限钳住链长）；best-effort */
  appendRecoveryInvoke(invokeId: string, recoveryInvokeId: string): Promise<void>;
  /** 按 invokeId 查队列行（认领失败后的原因区分：pending=超限 / 其他=已被认领或已终态） */
  getByInvokeId(invokeId: string): Promise<PendingResume | null>;
  /** 流转状态到终态（done/failed/exhausted），写 settled_at */
  settleResume(
    invokeId: string,
    status: ResumePendingStatus,
    settledAt: string,
  ): Promise<void>;
  /** F20261117 检视轮 持有校验 settle——仅当行未被他人持有（claim_token IS NULL）
   *  或持有者即本认领 token 时流转终态；changes=0 返回 false（行已被他人接管，
   *  本持有者不再覆盖他人终态——认领失败分支的 exhausted 兜底只对无主行生效）。 */
  settleResumeHeld(
    invokeId: string,
    token: string,
    status: ResumePendingStatus,
    settledAt: string,
  ): Promise<boolean>;
}
