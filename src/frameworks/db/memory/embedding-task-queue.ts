/**
 * F20261105embqg：任务优先级常量与 S3 水位阈值定义在 port 层（usecases/memory/memory-queue.ts）
 * ——本文件（frameworks）从 port 导入，依赖方向 frameworks→usecases。
 */
import { EMBED_TASK_PRIORITY } from "../../../usecases/memory/memory-queue";
import { estimateTokens } from "../../embedding/embed-batch-sharding";
import { percentile } from "../../embedding/embedding-lane-stats";

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
 * F20261026emct：入队前置校验——entry 已不存在或 content 为空时直接 no-op。
 * 2026-10-23 实锤：last_error='entry deleted' 的幽灵任务 1646 条——replaceEntriesBySource
 * 事务里新 chunk 已入库，但 fire-and-forget 的 embed 失败回除时新 chunk 已被下一轮 replace
 * 删除，enqueueRetry 给已删 entry 插入任务行；这类任务 claim 时 JOIN 不到 content，永远
 * 'entry deleted' 空转。闸门在此而非调用方：所有入队路径（store-memory / retry worker /
 * 启动迁移）共用此入口，一处拦截全部覆盖。置 0 行事务外发生，不影响主写入路径。
 */
/**
 * F20261105embqg：任务优先级语义见 port 层 EMBED_TASK_PRIORITY（usecases/memory/memory-queue.ts）。
 */
export function enqueueRetry(
  db: Database.Database,
  entryId: string,
  error: unknown,
  priority: number = EMBED_TASK_PRIORITY.normal,
): void {
  const row = db.prepare(
    "SELECT length(trim(content)) AS len FROM memory_entries WHERE id = ?",
  ).get(entryId) as { len: number | null } | undefined;
  if (!row || row.len === 0) return; // entry 不存在或 content 空：不入队，杜幽灵任务源头
  const errMsg = error instanceof Error ? error.message : String(error);
  db.prepare(`
    INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, last_error, priority)
    VALUES (?, datetime('now'), 'pending', datetime('now'), ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      next_retry_at = excluded.next_retry_at,
      last_error = excluded.last_error,
      status = 'pending'
      -- F20261105embqg：不更新 priority——保留首次入队优先级，
      -- 防低优先级生产者（bulk 重算）后到覆盖已在队的高优先级任务（live 消息）
  `).run(entryId, errMsg, priority);
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
  tokenBudget?: number,
): Array<{ entryId: string; content: string; attempts: number; lastAttemptAt: string | null; createdAt: string; priority: number }> {
  const effectiveLimit = tokenBudget === undefined
    ? limit
    : countTasksWithinTokenBudget(db, limit, tokenBudget);
  if (effectiveLimit === 0) return [];
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
      -- F20261105embqg：优先级序消费——live 消息（0）先于 bulk 重算（2）出队，
      -- 同级内保持 next_retry_at 时间序（退避语义不变）。无 priority 列的旧库
      -- 由 initSchema 幂等补列后此 SQL 才可达，不存在 NULL priority 行。
      ORDER BY priority ASC, next_retry_at ASC
      LIMIT ?
    )
    RETURNING entry_id, attempts, last_attempt_at, created_at, priority
  `).all(effectiveLimit) as Array<{ entry_id: string; attempts: number; last_attempt_at: string | null; created_at: string; priority: number }>;

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
    priority: r.priority,
  }));
}

/** 只选择有序候选的前缀；与后续原子 UPDATE 共用同一 ORDER BY，避免预算筛选改变公平性。 */
function countTasksWithinTokenBudget(db: Database.Database, limit: number, budget: number): number {
  const candidates = db.prepare(`
    SELECT et.entry_id, me.content
    FROM embedding_tasks et
    LEFT JOIN memory_entries me ON me.id = et.entry_id
    WHERE et.status = 'pending' AND et.next_retry_at <= datetime('now')
    ORDER BY et.priority ASC, et.next_retry_at ASC
    LIMIT ?
  `).all(limit) as Array<{ entry_id: string; content: string | null }>;
  let count = 0;
  let tokens = 0;
  for (const candidate of candidates) {
    const next = estimateTokens(candidate.content ?? "");
    // 单条超预算仍独占一批；文本不可拆，service 的单条豁免与此保持一致。
    if (count > 0 && tokens + next > budget) break;
    tokens += next;
    count++;
  }
  return count;
}

/**
 * F20261105embqg：当前 pending 任务总数——生产端水位闸门（S3）的判据。
 * 判据单一（队列深度），无时间/增速维度：机械可测、行为可预期，
 * 阈值调优只动常量不动逻辑（当日事故复盘：多因子自适应闸门自身会变成
 * 新的不可预期机制，见 F20261105embqg 设计取舍）。
 */
export function pendingTaskCount(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM embedding_tasks WHERE status = 'pending'",
  ).get() as { n: number };
  return row.n;
}

/**
 * F20261109epqst：队列健康快照——pending 总数 / 最老 pending 任务年龄（秒）/
 * 按优先级分布。验收抓手：最老任务年龄单调下降 = 旧任务持续出队；
 * 年龄停滞 = 消费停摆（生产实锤：09:14 迁入的 1000 条到 10:22 仍 attempts=0）。
 */
export function pendingTaskStats(db: Database.Database): {
  pending: number;
  oldestAgeSeconds: number | null;
  ageP50Seconds: number | null;
  ageP95Seconds: number | null;
  byPriority: Record<number, number>;
  earliestNextRetryAt: string | null;
} {
  const row = db.prepare(`
    SELECT COUNT(*) AS n,
           MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest,
           MIN(CASE WHEN status = 'pending' THEN next_retry_at END) AS earliest_next
    FROM embedding_tasks
  `).get() as { n: number; oldest: string | null; earliest_next: string | null };
  const prioRows = db.prepare(`
    SELECT priority, COUNT(*) AS n FROM embedding_tasks
    WHERE status = 'pending' GROUP BY priority
  `).all() as Array<{ priority: number; n: number }>;
  const byPriority: Record<number, number> = {};
  for (const r of prioRows) byPriority[r.priority] = r.n;
  const createdRows = db.prepare(`
    SELECT created_at FROM embedding_tasks WHERE status = 'pending'
  `).all() as Array<{ created_at: string }>;
  const ages = createdRows.map(r => {
    const createdMs = Date.parse(r.created_at.replace(" ", "T") + "Z");
    return Number.isFinite(createdMs) ? Math.max(0, Math.floor((Date.now() - createdMs) / 1000)) : 0;
  });
  const oldestAgeSeconds = ages.length > 0 ? Math.max(...ages) : null;
  return {
    pending: row.n,
    oldestAgeSeconds,
    ageP50Seconds: percentile(ages, 0.5),
    ageP95Seconds: percentile(ages, 0.95),
    byPriority,
    earliestNextRetryAt: row.earliest_next,
  };
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
 * F20261020slvg：启动时重置 pending 任务的 attempts 归零。
 * claim 即 attempts+1，而超时循环（不计失败）会反复 claim 把 attempts 撑到 ≥3——
 * 2026-10-16 活锁 4h40m 后存量 2905 条积压大量 attempts 虚高，不重置的话上线后
 * 遇到一次硬错误（或旧版瞬态错误）就成批 dead-letter。只在启动迁移调一次。
 * 返回重置的行数。
 *
 * F20261026emct：语义锁定——reset 只赦免 pending（活锁受害者），dead 是独立
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
 * F20261026emct：一次性出清孤儿任务——entry 已被删除的
 * 任务（真定义：entry_id NOT EXISTS，无论 last_error 形态）。首版只按
 * last_error LIKE '%entry deleted%' 代理口径删，DB 实测两类差额 129 条
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
 * F20261026emct：统计孤儿任务规模（真定义口径，dry-run 报告用，不删除）。
 */
export function countGhostTasks(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM embedding_tasks
    WHERE entry_id NOT IN (SELECT id FROM memory_entries)
  `).get() as { n: number };
  return row.n;
}
