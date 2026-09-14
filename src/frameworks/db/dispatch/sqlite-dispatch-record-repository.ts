import type Database from 'better-sqlite3';
import type { DispatchRecord, DispatchRecordFilter, DispatchStatus } from '@entities/dispatch/dispatch-record';
import type { DispatchRecordRepository } from '@usecases/dispatch/dispatch-record-repository';

/**
 * dispatch_records 的 SQLite 实现（F20260912avlb）。
 * 表结构在 schema.ts createDispatchRecordsTable 创建（幂等 CREATE IF NOT EXISTS）。
 * 取代旧 otter_context `dispatch:%` 伪存储（状态 100% 失真，见特性文档）。
 */
export class SqliteDispatchRecordRepository implements DispatchRecordRepository {
  constructor(private readonly db: Database.Database) {}

  async create(record: DispatchRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO dispatch_records (
        id, conversation_id, otter_id, otter_name, task, status, created_at, dispatched_at, dissolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.conversationId, record.otterId, record.otterName,
      record.task, record.status, record.createdAt, record.dispatchedAt, record.dissolvedAt,
    );
  }

  async markDispatched(otterId: string, conversationId: string): Promise<number> {
    // Why 只刷 created：首次派工时间戳是「创建到首派窗口」的唯一锚点，
    // 重复 yield（多轮交棒）不得刷新它（方案 delta 复审建议 1）
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE dispatch_records SET status = 'dispatched', dispatched_at = ? WHERE otter_id = ? AND conversation_id = ? AND status = 'created'",
    ).run(now, otterId, conversationId);
    return result.changes;
  }

  async markDissolved(otterId: string): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE dispatch_records SET status = 'dissolved', dissolved_at = ? WHERE otter_id = ? AND status != 'dissolved'",
    ).run(now, otterId);
    return result.changes;
  }

  async findByFilter(filter?: DispatchRecordFilter): Promise<DispatchRecord[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (filter?.conversationId) { parts.push('conversation_id = ?'); params.push(filter.conversationId); }
    if (filter?.otterId) { parts.push('otter_id = ?'); params.push(filter.otterId); }
    if (filter?.status) { parts.push('status = ?'); params.push(filter.status); }
    const limit = filter?.limit ?? 200;
    const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM dispatch_records${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as DispatchRecordRow[];
    return rows.map(rowToDispatchRecord);
  }

  migrateFromContext(): { migrated: number; ignored: number } {
    const rows = this.db.prepare(
      "SELECT otter_id, key, value FROM otter_context WHERE key LIKE 'dispatch:%'",
    ).all() as Array<{ otter_id: string; key: string; value: string }>;
    if (rows.length === 0) return { migrated: 0, ignored: 0 };

    // 全局 active 獭集合（delta 复审建议 2：dissolved 判定以 otters 表为准——
    // dissolve 销毁獭本体（全局事件），participant 名册在 leave 失败时残留不可靠）
    const activeIds = new Set(
      (this.db.prepare("SELECT id FROM otters WHERE status = 'active'").all() as Array<{ id: string }>).map(r => r.id),
    );

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO dispatch_records (
        id, conversation_id, otter_id, otter_name, task, status, created_at, dispatched_at, dissolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let migrated = 0;
    let ignored = 0;

    /** 单行迁移：JSON 解析 + 字段校验 + 状态映射 + 全局 dissolved 覆盖。
     *  拆出私有纯函数降 migrateFromContext 复杂度（eslint complexity 12 上限）。 */
    // eslint-disable-next-line complexity -- 字段校验 + 三态映射的分支密度来自数据规则本身，再拆只增加间接层
    const mapRow = (row: { otter_id: string; key: string; value: string }): unknown[] => {
      let record: {
        id?: string; conversationId?: string; otterId?: string; otterName?: string; task?: string;
        status?: string; createdAt?: string; updatedAt?: string;
      };
      try {
        record = JSON.parse(row.value);
      } catch (e) {
        // 坏 JSON 中断整体迁移（事务回滚）而非静默跳过——跳过会让删 key 丢数据
        throw new Error(`dispatch migration: bad JSON at otter_context(${row.otter_id}, ${row.key}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (!record.id || !record.conversationId || !record.otterId || !record.createdAt) {
        throw new Error(`dispatch migration: missing required field at otter_context(${row.otter_id}, ${row.key})`);
      }

      // 状态映射：pending → created（未派工）；其余（in_progress 及理论不存在的终态）→
      // dispatched（已派工是事实；dispatched_at 用原 updatedAt 近似——最后一次更新时间
      // 即最后一次派工时间的近似，cost-output「每日派工数」指标的历史数据不丢）
      const baseStatus: DispatchStatus = record.status === 'pending' ? 'created' : 'dispatched';
      const dispatchedAt = baseStatus === 'dispatched' ? (record.updatedAt ?? null) : null;
      // 全局覆盖：獭不在 active 集 → dissolved（dissolve 销毁獭本体是全局事件；
      // dissolved_at 历史不可知，如实 NULL）
      const status: DispatchStatus = activeIds.has(record.otterId) ? baseStatus : 'dissolved';

      return [
        record.id, record.conversationId, record.otterId, record.otterName ?? record.otterId,
        record.task ?? '', status, record.createdAt, dispatchedAt,
        null, // dissolved_at：迁移路径历史不可知，如实 NULL
      ];
    };

    // Why 整体单事务：任何一条坏数据抛错即全量回滚（旧 key 保留，修复后重跑）——
    // 数据搬家非复制，半途状态 = 双源漂移
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const result = insert.run(...(mapRow(row) as [string, string, string, string, string, string, string, string | null, null]));
        if (result.changes > 0) migrated++; else ignored++;
      }
      // 数据搬家非复制：全量删除旧 key（含被 OR IGNORE 的行——其数据已等价存在于新表）
      this.db.prepare("DELETE FROM otter_context WHERE key LIKE 'dispatch:%'").run();
    });
    migrate();
    return { migrated, ignored };
  }
}

/** SQLite 行类型（snake_case，schema.ts createDispatchRecordsTable） */
interface DispatchRecordRow {
  id: string;
  conversation_id: string;
  otter_id: string;
  otter_name: string;
  task: string;
  status: string;
  created_at: string;
  dispatched_at: string | null;
  dissolved_at: string | null;
}

/** DB Row -> Entity */
function rowToDispatchRecord(row: DispatchRecordRow): DispatchRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    otterId: row.otter_id,
    otterName: row.otter_name,
    task: row.task,
    status: row.status as DispatchStatus,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    dissolvedAt: row.dissolved_at,
  };
}
