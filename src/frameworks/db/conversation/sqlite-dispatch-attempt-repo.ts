import type Database from "better-sqlite3";
import type { DispatchAttempt, DispatchAttemptRepo, PendingSignalRow } from "@entities/conversation/dispatch-attempt";

/**
 * F20260902sgp2 S1：派发台账 SQLite 实现。
 * 全部方法同步（better-sqlite3 同步 API）且自带事务语义（单语句原子）；
 * 插桩方（链引擎）负责 try/catch——台账失败绝不阻断链路（硬约束 1）。
 */
export class SqliteDispatchAttemptRepo implements DispatchAttemptRepo {
  constructor(private readonly db: Database.Database) {}

  recordStart(attempt: DispatchAttempt): void {
    const prev = this.db.prepare(
      "SELECT status, source, note FROM dispatch_attempts WHERE message_id = ? AND target_otter_id = ?",
    ).get(attempt.messageId, attempt.targetOtterId) as { status: string; source: string; note: string | null } | undefined;
    // §8.2 折中：覆盖前压缩旧行前情（retry 历史是排查线索——硬约束 2）
    let note = attempt.note ?? null;
    if (prev) {
      const prevSummary = `prev=${prev.status}${prev.note ? `: ${prev.note}` : ""} @${prev.source}`;
      note = note ? `${note}; ${prevSummary}` : prevSummary;
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO dispatch_attempts
        (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at, attempt_finished_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(attempt.id, attempt.conversationId, attempt.messageId, attempt.targetOtterId,
      attempt.status, attempt.source, attempt.attemptStartedAt, note);
  }

  recordFinish(messageId: string, targetOtterId: string, status: "completed" | "failed" | "aborted", note?: string | null): void {
    this.db.prepare(`
      UPDATE dispatch_attempts
      SET status = ?, attempt_finished_at = datetime('now'),
          note = CASE WHEN ? IS NOT NULL THEN ? ELSE note END
      WHERE message_id = ? AND target_otter_id = ?
    `).run(status, note ?? null, note ?? null, messageId, targetOtterId);
  }

  backfillLegacyAttempted(): number {
    // §4.5 墓碑：存量已投递消息 × otter 目标一刀标记 legacy-attempted（completed 终态）。
    // 「已投递」判据与 §4.3 pending SQL 同源（completed ∧ 非 system ∧ tsp 含 otter 目标）——
    // 审视建议 2 的故意分歧：此处【不】加 c.status='active' 过滤——墓碑宁多勿少：归档会话
    // 的历史消息也翻篇，防「归档→复活」窗口内陈年信号变 pending 误点（rbsg 安全偏置）。
    // 幂等：OR IGNORE 跳过已有记录的 (message, target)（本方法仅 S1 迁移调用一次，防御性幂等）。
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO dispatch_attempts
        (id, conversation_id, message_id, target_otter_id, status, source, attempt_started_at, attempt_finished_at, note)
      SELECT lower(hex(randomblob(16))), m.conversation_id, m.id, t.value,
             'completed', 'backfill', datetime('now'), datetime('now'), 'legacy-attempted（sgp2 S1 切换墓碑，存量视为已翻篇）'
      FROM messages m, json_each(m.talking_stone_passed_to) t
      WHERE m.status = 'completed'
        AND m.sender_type != 'system'
        AND t.value != 'user'
        AND t.value != m.sender_id
        AND EXISTS (SELECT 1 FROM otters o WHERE o.id = t.value)
    `).run();
    return result.changes;
  }

  /** §4.3 pending 判据 SQL——与 v2 路由器（S2）、轨迹 UI（S1b）单一真相源 */
  private pendingClause(conversationId?: string): { where: string; params: unknown[] } {
    const where = `
      FROM messages m, json_each(m.talking_stone_passed_to) t
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.status = 'completed'
        AND m.sender_type != 'system'
        AND c.status = 'active'
        AND t.value != 'user'
        AND t.value != m.sender_id
        AND EXISTS (SELECT 1 FROM otters o WHERE o.id = t.value)
        AND NOT EXISTS (SELECT 1 FROM dispatch_attempts da
                        WHERE da.message_id = m.id AND da.target_otter_id = t.value)`;
    if (conversationId) return { where: `${where} AND m.conversation_id = ?`, params: [conversationId] };
    return { where, params: [] };
  }

  countPendingSignals(conversationId?: string): number {
    const { where, params } = this.pendingClause(conversationId);
    const row = this.db.prepare(`SELECT count(*) AS n ${where}`).get(...params) as { n: number };
    return row.n;
  }

  /** S1b 轨迹 UI：本会话全部 attempt（无 limit——(message,target) 唯一键防膨胀） */
  listAttemptsForConversation(conversationId: string): DispatchAttempt[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, message_id, target_otter_id, status, source,
             attempt_started_at, attempt_finished_at, note
      FROM dispatch_attempts WHERE conversation_id = ?
    `).all(conversationId) as Array<{
      id: string; conversation_id: string; message_id: string; target_otter_id: string;
      status: string; source: string; attempt_started_at: string;
      attempt_finished_at: string | null; note: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      targetOtterId: r.target_otter_id,
      status: r.status as DispatchAttempt["status"],
      source: r.source as DispatchAttempt["source"],
      attemptStartedAt: r.attempt_started_at,
      attemptFinishedAt: r.attempt_finished_at,
      note: r.note,
    }));
  }

  listPendingSignals(conversationId?: string, limit = 50): PendingSignalRow[] {
    const { where, params } = this.pendingClause(conversationId);
    return this.db.prepare(`
      SELECT m.id AS messageId, m.conversation_id AS conversationId,
             t.value AS targetOtterId, m.signal_level AS signalLevel, m.created_at AS createdAt
      ${where} ORDER BY m.created_at DESC LIMIT ?
    `).all(...params, limit) as PendingSignalRow[];
  }

  markStaleInProgressFailed(): number {
    // §4.4 死亡证明（flash 对撞③）：进程内无存活的 in_progress 跨越重启。
    // 先例 reconcile-orphans.ts:50 failInFlightMessages 同款语义。
    const result = this.db.prepare(`
      UPDATE dispatch_attempts
      SET status = 'failed', attempt_finished_at = datetime('now'),
          note = COALESCE(note || '; ', '') || '进程重启，派发中断（sgp2 死亡证明）'
      WHERE status = 'in_progress'
    `).run();
    return result.changes;
  }
}
