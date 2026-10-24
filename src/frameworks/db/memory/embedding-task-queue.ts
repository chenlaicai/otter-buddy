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
 *
 * F20261023emct：入队前置校验——entry 已不存在或 content 为空时直接 no-op。
 * 2026-10-23 实锤：last_error='entry deleted' 的幽灵任务 1646 条——replaceEntriesBySource
 * 事务里新 chunk 已入库，但 fire-and-forget 的 embed 失败回除时新 chunk 已被下一轮 replace
 * 删除，enqueueRetry 给已删 entry 插入任务行；这类任务 claim 时 JOIN 不到 content，永远
 * 'entry deleted' 空转。闸门在此而非调用方：所有入队路径（store-memory / retry worker /
 * 启动迁移）共用此入口，一处拦截全部覆盖。置 0 行事务外发生，不影响主写入路径。
 */
export function enqueueRetry(db: Database.Database, entryId: string, error: unknown): void {
  const row = db.prepare(
    "SELECT length(trim(content)) AS len FROM memory_entries WHERE id = ?",
  ).get(entryId) as { len: number | null } | undefined;
  if (!row || row.len === 0) return; // entry 不存在或 content 空：不入队，杜幽灵任务源头
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

/**
 * F20261020slvg 对抗审视洞 2 处置：启动时重置 pending 任务的 attempts 归零。
 * claim 即 attempts+1，而超时循环（不计失败）会反复 claim 把 attempts 撑到 ≥3——
 * 2026-10-16 活锁 4h40m 后存量 2905 条积压大量 attempts 虚高，不重置的话上线后
 * 遇到一次硬错误（或旧版瞬态错误）就成批 dead-letter。只在启动迁移调一次。
 * 返回重置的行数。
 *
 * F20261023emct：语义锁定——reset 只赦免 pending（活锁受害者），dead 是独立
 * 判定的终态（真不可嵌入/entry 已删），不赦免（SQL 本就如此，注释显式锁定，
 * 防未来重构误改 WHERE 加上 dead）。2026-10-23 实锤：dead 不收敛越滚越大
 * （686 条）正是启动迁移 includeDead=true 复活 dead + 不清理幽灵造成的。
 */
export function resetPendingAttempts(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE embedding_tasks
    SET attempts = 0, next_retry_at = datetime('now')
    WHERE status = 'pending' AND attempts > 0
  `).run();
  return result.changes;
}

/**
 * F20261023emct：一次性出清孤儿任务（delta 复审口径修正）——entry 已被删除的
 * 任务（真定义：entry_id NOT EXISTS，无论 last_error 形态）。首版只按
 * last_error LIKE '%entry deleted%' 代理口径删，检视獭 DB 实测两类差额 129 条
 * （含 98 条 10-23 巨批超时残骸 'batch timeout (49 texts)'）——代理口径外的孤儿
 * 会被 claim 打上 entry-deleted 后 3 次 dead 永久滞留。运行时路径不调（修复后
 * enqueueRetry 前置校验已断绝新幽灵产生源），仅清理脚本
 * cleanup-embedding-ghosts.mjs 用于出清存量。返回删除行数。
 */
export function purgeGhostTasks(db: Database.Database): number {
  const result = db.prepare(`
    DELETE FROM embedding_tasks
    WHERE entry_id NOT IN (SELECT id FROM memory_entries)
  `).run();
  return result.changes;
}

/**
 * F20261023emct：统计孤儿任务规模（真定义口径，dry-run 报告用，不删除）。
 */
export function countGhostTasks(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM embedding_tasks
    WHERE entry_id NOT IN (SELECT id FROM memory_entries)
  `).get() as { n: number };
  return row.n;
}
