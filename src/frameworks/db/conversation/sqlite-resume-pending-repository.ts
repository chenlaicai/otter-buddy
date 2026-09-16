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

  async listRecentConversationIds(beforeTimestamp: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT conversation_id AS cid FROM invokes WHERE started_at < ? " +
        "UNION SELECT conversation_id AS cid FROM entries " +
        "WHERE entry_type = 'invoke_start' AND created_at < ?",
    ).all(beforeTimestamp, beforeTimestamp) as Array<{ cid: string }>;
    return rows.map(r => r.cid);
  }

  /** S1 修复（PR #994 检视）：attempts 上限防跨重启无限重试——恢复中崩溃则 pending 残留，
   *  下次重启重拾再崩溃 → 无限循环（配额耗尽型 429 场景每次重启白烧 LLM 调用，#843 实证）。
   *  上限值 5：每次重启恢复消耗 1 attempts（认领只在恢复入口一次，进程内 429 退避
   *  不重认领），允许 5 次重启窗口（旧实现 MAX=1 太激进——crash-recovery 只给一次
   *  机会不够）。 */
  private static readonly MAX_RESUME_ATTEMPTS = 5;

  async claimPendingResume(invokeId: string): Promise<boolean> {
    const result = this.db.prepare(
      "UPDATE restart_pending_resumes SET attempts = attempts + 1 WHERE invoke_id = ? AND status = 'pending' AND attempts < ?",
    ).run(invokeId, SqliteResumePendingRepository.MAX_RESUME_ATTEMPTS);
    return result.changes > 0;
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
