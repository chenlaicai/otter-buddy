import type Database from "better-sqlite3";

export interface MemoryVecAudit {
  total: number;
  live: number;
  orphan: number;
  orphanRatio: number;
}

export interface MemoryVecCleanupResult {
  before: MemoryVecAudit;
  after: MemoryVecAudit;
  deleted: number;
}

interface MemoryVecCountRow {
  total: number;
  live: number;
  orphan: number;
}

/** 只输出索引计数；调用方须先加载 sqlite-vec，避免把缺表误报成零孤儿。 */
export function auditMemoryVec(db: Database.Database): MemoryVecAudit {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN me.id IS NOT NULL THEN 1 ELSE 0 END) AS live,
      SUM(CASE WHEN me.id IS NULL THEN 1 ELSE 0 END) AS orphan
    FROM memory_vec mv
    LEFT JOIN memory_entries me ON me.id = mv.memory_entry_id
  `).get() as MemoryVecCountRow;
  const total = Number(row.total);
  const live = Number(row.live ?? 0);
  const orphan = Number(row.orphan ?? 0);
  return { total, live, orphan, orphanRatio: total === 0 ? 0 : orphan / total };
}

/** 单事务删除并在同一事务内复审；备份与显式授权由脚本入口负责。 */
export function cleanupMemoryVec(db: Database.Database): MemoryVecCleanupResult {
  return db.transaction(() => {
    const before = auditMemoryVec(db);
    const deleted = db.prepare(`
      DELETE FROM memory_vec
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_entries me WHERE me.id = memory_vec.memory_entry_id
      )
    `).run().changes;
    const after = auditMemoryVec(db);
    if (after.orphan !== 0) {
      throw new Error(`memory_vec 清理后仍有 ${after.orphan} 条孤儿索引，事务已回滚`);
    }
    return { before, after, deleted };
  })();
}
