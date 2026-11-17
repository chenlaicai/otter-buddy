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
    recoveryInvokeId: row.recovery_invoke_id,
  };
}

/** F20260916b1ea：restart_pending_resumes 表 sqlite 实现（invoke 模型重建版） */
export class SqliteResumePendingRepository implements ResumePendingRepository {
  constructor(private readonly db: Database.Database) {}

  async getPendingResumes(): Promise<PendingResume[]> {
    const rows = this.db.prepare(
      "SELECT * FROM restart_pending_resumes WHERE status = 'pending' ORDER BY created_at ASC",
    ).all() as PendingResumeRow[];
    return rows.map(rowToPendingResume);
  }

  /** S1 修复（PR #994 检视）：attempts 上限防跨重启无限重试——恢复中崩溃则 pending 残留，
   *  下次重启重拾再崩溃 → 无限循环（配额耗尽型 429 场景每次重启白烧 LLM 调用，#843 实证）。
   *  上限值 5：每次重启恢复消耗 1 attempts（认领只在恢复入口一次，进程内 429 退避
   *  不重认领），允许 5 次重启窗口（旧实现 MAX=1 太激进——crash-recovery 只给一次
   *  机会不够）。 */
  private static readonly MAX_RESUME_ATTEMPTS = 5;

  async claimPendingResume(invokeId: string, claim: { token: string; bootEpoch: number }): Promise<boolean> {
    // F20261116actlg PR-B：认领绑定 token+epoch——同 boot 内已认领拒重认领（boot_epoch = 本次纪元
    // 且已有 token = 本 boot 已有持有者）；旧纪元残留可重认领（恢复者自身崩溃不留死锁）；
    // attempts 每次认领（含重认领）自增，上限守卫不放松。
    const result = this.db.prepare(
      "UPDATE restart_pending_resumes SET attempts = attempts + 1, claim_token = ?, boot_epoch = ? "
      + "WHERE invoke_id = ? AND status = 'pending' AND attempts < ? "
      + "AND (claim_token IS NULL OR boot_epoch IS NULL OR boot_epoch != ?)",
    ).run(claim.token, claim.bootEpoch, invokeId, SqliteResumePendingRepository.MAX_RESUME_ATTEMPTS, claim.bootEpoch);
    return result.changes > 0;
  }

  async backfillRecoveryInvoke(invokeId: string, recoveryInvokeId: string): Promise<void> {
    this.db.prepare(
      "UPDATE restart_pending_resumes SET recovery_invoke_id = ? WHERE invoke_id = ?",
    ).run(recoveryInvokeId, invokeId);
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
}
