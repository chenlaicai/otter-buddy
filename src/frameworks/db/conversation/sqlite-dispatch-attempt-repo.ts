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

  /** §4.3 pending 判据 SQL——与 v2 路由器（S2）、轨迹 UI（S1b）单一真相源。
   *  F20260903damp：目标 EXISTS 加 o.status='active'——指向 dissolved 目标的信号不是
   *  actionable pending（行动人已不存在），从计数/扫描/补扫中消失（留箱静默）。
   *  09-03 事故：dissolved 检视獭的遗留信号被补扫点火 → 50ms 重扫热循环。
   *  注意与 backfillLegacyAttempted 的故意分歧（墓碑宁多勿少，不加 status）保持不变。 */
  private pendingClause(conversationId?: string): { where: string; params: unknown[] } {
    const where = `
      FROM messages m, json_each(m.talking_stone_passed_to) t
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.status = 'completed'
        AND m.sender_type != 'system'
        AND c.status = 'active'
        AND t.value != 'user'
        AND t.value != m.sender_id
        AND EXISTS (SELECT 1 FROM otters o WHERE o.id = t.value AND o.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM dispatch_attempts da
                        WHERE da.message_id = m.id AND da.target_otter_id = t.value)
        -- F20260903dmpe 阻尼1a：当前 UNIQUE 约束下此条件逻辑冗余（第一个 NOT EXISTS
        -- 已排除任何行）。保留意图：future-proof——若 UNIQUE 放松为 append-only
        -- （多轮尝试历史），failed 终态行不得让信号重回 pending（无自动重试的判据面）。
        AND NOT EXISTS (SELECT 1 FROM dispatch_attempts df
                        WHERE df.message_id = m.id AND df.target_otter_id = t.value
                          AND df.status IN ('failed', 'aborted'))`;
    if (conversationId) return { where: `${where} AND m.conversation_id = ?`, params: [conversationId] };
    return { where, params: [] };
  }

  countPendingSignals(conversationId?: string): number {
    const { where, params } = this.pendingClause(conversationId);
    const row = this.db.prepare(`SELECT count(*) AS n ${where}`).get(...params) as { n: number };
    return row.n;
  }

  /** K2 收件箱预告（F20260903k23，#757 审视焦点 1 修复）：目标獭的 pending 精确计数。
   *  无 limit（预告数字必须诚实——listPendingSignals+filter 会双重封顶漏报）；
   *  total 与 halt 一次查询带回（SQL 条件聚合，避免两遍扫描）。 */
  countPendingForTarget(conversationId: string, targetOtterId: string): { total: number; halt: number } {
    const { where, params } = this.pendingClause(conversationId);
    const row = this.db.prepare(`
      SELECT count(*) AS total,
             COALESCE(SUM(CASE WHEN UPPER(COALESCE(m.signal_level, 'NORMAL')) = 'HALT' THEN 1 ELSE 0 END), 0) AS halt
      ${where} AND t.value = ?
    `).get(...params, targetOtterId) as { total: number; halt: number };
    return { total: row.total, halt: row.halt };
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
    // F20260903damp 阻尼#1：重扫只碰「从未派发」的行（attempts=0）。
    // 含 failed 终态行的信号不进重扫视野——「无自动重试」从口号机制化：
    // 失败信号再点火只能走用户手动 retry（覆盖式，source='retry'）。
    // 09-03 事故形态：failed 无行 → 50ms 重扫永燃；本守卫使失效模式落在哑火侧。
    const { where, params } = this.pendingClause(conversationId);
    return this.db.prepare(`
      SELECT m.id AS messageId, m.conversation_id AS conversationId,
             t.value AS targetOtterId, m.signal_level AS signalLevel, m.created_at AS createdAt
      ${where} ORDER BY m.created_at DESC LIMIT ?
    `).all(...params, limit) as PendingSignalRow[];
  }

  /** F20260903damp 阻尼#1 补充：同 (message,target) 最小点火间隔守卫。
   *  @returns true = 允许点火（首次，或距上次点火超过间隔）；false = 阻尼中。
   *  间隔语义： attempts 行的 attempt_started_at 距 now 不足 minIntervalSec 秒时拒绝。
   *  为什么在 repo 层：与 pending 判据同一真相源文件，且测试可用真库验证时间边界。 */
  shouldThrottle(messageId: string, targetOtterId: string, minIntervalSec: number): boolean {
    const row = this.db.prepare(`
      SELECT attempt_started_at FROM dispatch_attempts
      WHERE message_id = ? AND target_otter_id = ?
      ORDER BY attempt_started_at DESC LIMIT 1
    `).get(messageId, targetOtterId) as { attempt_started_at: string } | undefined;
    if (!row) return false; // 无记录 = 首次，不阻尼
    const last = Date.parse(row.attempt_started_at.includes("T") ? row.attempt_started_at : row.attempt_started_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(last)) return false; // 脏时间戳按不阻尼（宁多勿错）
    return Date.now() - last < minIntervalSec * 1000;
  }

  allAnchorAttemptsSettled(messageId: string): boolean {
    const row = this.db.prepare(`
      SELECT count(*) AS n FROM dispatch_attempts
      WHERE message_id = ? AND status = 'in_progress'
    `).get(messageId) as { n: number };
    const total = this.db.prepare(`
      SELECT count(*) AS n FROM dispatch_attempts WHERE message_id = ?
    `).get(messageId) as { n: number };
    // 无行 = 信号还没被派发过（保守：不算收工，等消息层判定）
    if (total.n === 0) return false;
    return row.n === 0;
  }

  failAllInProgressForOtter(otterId: string): number {
    // F20260903dmpe 阻尼#4（S4 补丁批）：dissolve 獭名下 in_progress 全部落 failed。
    // 与 markStaleInProgressFailed 的区别：按 otter 维度（解散场景），非全表。
    return this.db.prepare(`
      UPDATE dispatch_attempts
      SET status = 'failed', attempt_finished_at = datetime('now'),
          note = COALESCE(note || '; ', '') || '目标已解散，派发无主（dissolve 销账）'
      WHERE status = 'in_progress' AND target_otter_id = ?
    `).run(otterId).changes;
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
