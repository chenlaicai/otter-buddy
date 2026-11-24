import type Database from "better-sqlite3";
import type {
  PendingResume,
  ResumePendingStatus,
} from "@entities/conversation/pending-resume";
import type { ResumePendingRepository } from "@usecases/conversation/resume-pending-repository";

interface PendingResumeRow {
  invoke_id: string;
  conversation_id: string;
  otter_id: string;
  trigger_entry_id: string | null;
  status: string;
  attempts: number;
  created_at: string;
  settled_at: string | null;
  claim_token: string | null;
  boot_epoch: number | null;
  claim_pid: number | null;
  recovery_invoke_id: string | null;
}

function rowToPendingResume(row: PendingResumeRow): PendingResume {
  return {
    invokeId: row.invoke_id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    triggerEntryId: row.trigger_entry_id,
    status: row.status as ResumePendingStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    claimToken: row.claim_token,
    bootEpoch: row.boot_epoch,
    claimPid: row.claim_pid,
    recoveryInvokeId: row.recovery_invoke_id,
  };
}

/** restart_pending_resumes 表 sqlite 实现（invoke 模型重建版） */
export class SqliteResumePendingRepository implements ResumePendingRepository {
  constructor(private readonly db: Database.Database) {}

  async getPendingResumes(): Promise<PendingResume[]> {
    const rows = this.db.prepare(
      "SELECT * FROM restart_pending_resumes WHERE status = 'pending' ORDER BY created_at ASC",
    ).all() as PendingResumeRow[];
    return rows.map(rowToPendingResume);
  }

  /** 修复（检视）：attempts 上限防跨重启无限重试——恢复中崩溃则 pending 残留，
   * 下次重启重拾再崩溃 → 无限循环（配额耗尽型 429 场景每次重启白烧 LLM 调用，实证）。
   *  上限值 5：每次重启恢复消耗 1 attempts（认领只在恢复入口一次，进程内 429 退避
   *  不重认领），允许 5 次重启窗口（旧实现 MAX=1 太激进——crash-recovery 只给一次
   *  机会不够）。
   *  #2016 链级语义由 bootstrap 入队继承保证：子恢复行从父行 attempts 起步，
   *  因此本 SQL 的逐行 attempts<5 同时约束整条恢复链；普通首闯仍从 0 开始。 */
  private static readonly MAX_RESUME_ATTEMPTS = 5;

  async claimPendingResume(invokeId: string, claim: { token: string; bootEpoch: number; pid: number }): Promise<boolean> {
    // 认领绑定 token+epoch（补 pid）——同 boot 内已认领
    // 拒重认领（boot_epoch = 本次纪元且已有 token = 本 boot 已有持有者）；旧纪元残留可重认领
    // （恢复者自身崩溃不留死锁，服务层预检旧持有者 pid 死活）；attempts 每次认领（含重认领）
    // 自增，上限守卫不放松。
    const result = this.db.prepare(
      "UPDATE restart_pending_resumes SET attempts = attempts + 1, claim_token = ?, boot_epoch = ?, claim_pid = ? "
      + "WHERE invoke_id = ? AND status = 'pending' AND attempts < ? "
      + "AND (claim_token IS NULL OR boot_epoch IS NULL OR boot_epoch != ?)",
    ).run(claim.token, claim.bootEpoch, claim.pid, invokeId, SqliteResumePendingRepository.MAX_RESUME_ATTEMPTS, claim.bootEpoch);
    return result.changes > 0;
  }

  async appendRecoveryInvoke(invokeId: string, recoveryInvokeId: string): Promise<void> {
    // 追加式审计链——多次恢复全历史不丢（单槽覆盖改逗号追加，
    // attempts 上限钳住链长 ≤5）；首次写入为单值，兼容既有单次恢复断言。
    this.db.prepare(
      "UPDATE restart_pending_resumes SET recovery_invoke_id = "
      + "CASE WHEN recovery_invoke_id IS NULL OR recovery_invoke_id = '' THEN ? "
      + "ELSE recovery_invoke_id || ',' || ? END WHERE invoke_id = ?",
    ).run(recoveryInvokeId, recoveryInvokeId, invokeId);
  }

  async getByInvokeId(invokeId: string): Promise<PendingResume | null> {
    const row = this.db.prepare(
      "SELECT * FROM restart_pending_resumes WHERE invoke_id = ?",
    ).get(invokeId) as PendingResumeRow | undefined;
    return row ? rowToPendingResume(row) : null;
  }

  async settleResume(
    invokeId: string,
    status: ResumePendingStatus,
    settledAt: string,
  ): Promise<void> {
    this.db.prepare(
      "UPDATE restart_pending_resumes SET status = ?, settled_at = ? WHERE invoke_id = ?",
    ).run(status, settledAt, invokeId);
  }

  async settleResumeHeld(
    invokeId: string,
    token: string,
    status: ResumePendingStatus,
    settledAt: string,
  ): Promise<boolean> {
    // claim_token 真消费——持有者收口终态。仅当行无主（token IS NULL，
    // 存量库迁移行）或持有者即本 token 时写入；行已被他人接管则 changes=0（本持有者
    // 不覆盖他人终态，交由接管者负责闭环）。
    const result = this.db.prepare(
      "UPDATE restart_pending_resumes SET status = ?, settled_at = ? "
      + "WHERE invoke_id = ? AND (claim_token = ? OR claim_token IS NULL)",
    ).run(status, settledAt, invokeId, token);
    return result.changes > 0;
  }
}
