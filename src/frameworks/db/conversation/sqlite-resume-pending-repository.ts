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

  async claimPendingResume(invokeId: string): Promise<boolean> {
    const result = this.db.prepare(
      "UPDATE restart_pending_resumes SET attempts = attempts + 1 WHERE invoke_id = ? AND status = 'pending'",
    ).run(invokeId);
    return result.changes > 0;
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
