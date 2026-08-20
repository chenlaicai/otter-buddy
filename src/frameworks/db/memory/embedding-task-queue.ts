/**
 * F20260812mrcq Part 1：embedding 失败重试任务队列（embedding_tasks 表）SQL。
 * F20260814qswp 从 sqlite-memory-repository.ts 拆出——job-queue 职责与 entry 存储正交；
 * Repository 的 port 方法委托到这里的纯函数。
 */
import type Database from "better-sqlite3";

/**
 * embedding 失败入队重试。
 * ON CONFLICT(entry_id) DO UPDATE：
 *   - 不重置 attempts（避免无限重试）
 *   - status 强制 'pending'（dead 也可被 enqueueRetry 复活）
 *   - next_retry_at = now（立即可重试）
 */
export function enqueueRetry(db: Database.Database, entryId: string, error: unknown): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  db.prepare(`
    INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, last_error)
    VALUES (?, datetime('now'), 'pending', datetime('now'), ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      next_retry_at = excluded.next_retry_at,
      last_error = excluded.last_error,
      status = 'pending'
  `).run(entryId, errMsg);
}

/**
 * 原子认领 pending 任务（SQLite 3.35+ RETURNING）。
 * attempts 自增 1（claim 即视为已尝试）。
 * 指数退避：next_retry_at 按 attempts 计算（30s/60s/120s 封顶 1h）。
 * JOIN memory_entries 获取 content（content 不冗余存储）。
 * 若 entry 已被删除（JOIN 不到），claim 返回 content=''，tick 会跳过转 dead。
 */
export function claimPendingTasks(
  db: Database.Database,
  limit: number,
): Array<{ entryId: string; content: string; attempts: number; lastAttemptAt: string | null; createdAt: string }> {
  const rows = db.prepare(`
    UPDATE embedding_tasks
    SET last_attempt_at = datetime('now'),
        next_retry_at = datetime('now', '+' ||
          CASE attempts
            WHEN 0 THEN '30'
            WHEN 1 THEN '60'
            WHEN 2 THEN '120'
            WHEN 3 THEN '300'
            ELSE '3600'
          END || ' seconds'),
        attempts = attempts + 1
    WHERE entry_id IN (
      SELECT entry_id FROM embedding_tasks
      WHERE status = 'pending'
        AND next_retry_at <= datetime('now')
      LIMIT ?
    )
    RETURNING entry_id, attempts, last_attempt_at, created_at
  `).all(limit) as Array<{ entry_id: string; attempts: number; last_attempt_at: string | null; created_at: string }>;

  if (rows.length === 0) return [];
  // 二次查询 JOIN memory_entries 拿 content
  const placeholders = rows.map(() => "?").join(",");
  const entryRows = db.prepare(`
    SELECT id, content FROM memory_entries WHERE id IN (${placeholders})
  `).all(...rows.map(r => r.entry_id)) as Array<{ id: string; content: string }>;
  const contentMap = new Map(entryRows.map(r => [r.id, r.content]));
  return rows.map(r => ({
    entryId: r.entry_id,
    content: contentMap.get(r.entry_id) ?? "",
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    createdAt: r.created_at,
  }));
}

/** task 成功，删除 task 行 */
export function markTaskDone(db: Database.Database, entryId: string): void {
  db.prepare(`DELETE FROM embedding_tasks WHERE entry_id = ?`).run(entryId);
}

/**
 * task 失败，更新 last_error。
 * 若 attempts >= maxAttempts，status 转 'dead'（不再被 claimPendingTasks 选取）。
 */
export function markTaskAttemptFailed(db: Database.Database, entryId: string, error: unknown, maxAttempts: number): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  db.prepare(`
    UPDATE embedding_tasks
    SET last_error = ?,
        status = CASE WHEN attempts >= ? THEN 'dead' ELSE status END
    WHERE entry_id = ?
  `).run(errMsg, maxAttempts, entryId);
}
