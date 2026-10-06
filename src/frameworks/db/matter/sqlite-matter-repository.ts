import type Database from 'better-sqlite3';
import type { Matter, MatterQueryFilter } from '@entities/matter/matter';
import type { MatterRepository } from '@usecases/matter/matter-repository';

/**
 * Matters 的 SQLite 实现（F20261005mtlp P1）。
 * 表结构在 schema.ts createMattersTable 创建（幂等 CREATE IF NOT EXISTS）。
 */

export interface MatterRow {
  id: string;
  conversation_id: string;
  title: string;
  origin_message_id: string | null;
  owner_otter_id: string | null;
  level: string | null;
  state: string;
  waiting_on: string | null;
  waiting_for: string | null;
  payload: string | null;
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** DB Row -> Entity */
export function rowToMatter(row: MatterRow): Matter {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    originMessageId: row.origin_message_id,
    ownerOtterId: row.owner_otter_id,
    level: (row.level as Matter['level']) ?? null,
    state: row.state as Matter['state'],
    waitingOn: row.waiting_on,
    waitingFor: row.waiting_for,
    payload: row.payload,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** 查询过滤 WHERE 片段（AND 拼接，参数数组同步返回） */
export function buildMatterFilterClause(filter: MatterQueryFilter | undefined): { clause: string; params: unknown[] } {
  if (!filter) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.openOnly) {
    parts.push("state IN ('OPEN','WAITING_OTTER','WAITING_PARTNER','DONE_PENDING_CONFIRM')");
  } else if (filter.state) {
    parts.push('state = ?');
    params.push(filter.state);
  }
  if (filter.ownerOtterId) { parts.push('owner_otter_id = ?'); params.push(filter.ownerOtterId); }
  if (filter.waitingOn) { parts.push('waiting_on = ?'); params.push(filter.waitingOn); }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

export class SqliteMatterRepository implements MatterRepository {
  constructor(private readonly db: Database.Database) {}

  async create(matter: Matter): Promise<void> {
    this.db.prepare(`
      INSERT INTO matters (
        id, conversation_id, title, origin_message_id, owner_otter_id,
        level, state, waiting_on, waiting_for, payload, resolution, resolved_by,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      matter.id,
      matter.conversationId,
      matter.title,
      matter.originMessageId,
      matter.ownerOtterId,
      matter.level,
      matter.state,
      matter.waitingOn,
      matter.waitingFor,
      matter.payload,
      matter.resolution,
      matter.resolvedBy,
      matter.createdAt,
      matter.updatedAt,
      matter.closedAt,
    );
  }

  async findById(id: string): Promise<Matter | null> {
    const row = this.db.prepare('SELECT * FROM matters WHERE id = ?').get(id) as MatterRow | undefined;
    return row ? rowToMatter(row) : null;
  }

  async findByConversation(conversationId: string, filter?: MatterQueryFilter, limit = 50): Promise<Matter[]> {
    const { clause, params } = buildMatterFilterClause(filter);
    const rows = this.db.prepare(
      `SELECT * FROM matters WHERE conversation_id = ?${clause} ORDER BY created_at DESC LIMIT ?`,
    ).all(conversationId, ...params, limit) as MatterRow[];
    return rows.map(rowToMatter);
  }

  /** 条件更新（乐观锁：WHERE state = ?）——并发迁移只有一方成功，另一方走幂等/冲突语义 */
  async transition(
    id: string,
    fromState: Matter['state'],
    patch: Partial<Pick<Matter, 'state' | 'waitingOn' | 'waitingFor' | 'payload' | 'resolution' | 'resolvedBy' | 'ownerOtterId' | 'level'>> & { updatedAt: string; closedAt?: string | null },
  ): Promise<Matter | null> {
    const result = this.db.prepare(`
      UPDATE matters SET
        state = ?, waiting_on = ?, waiting_for = ?, payload = ?,
        resolution = ?, resolved_by = ?, updated_at = ?, closed_at = ?
      WHERE id = ? AND state = ?
    `).run(
      patch.state!,
      patch.waitingOn ?? null,
      patch.waitingFor ?? null,
      patch.payload ?? null,
      patch.resolution ?? null,
      patch.resolvedBy ?? null,
      patch.updatedAt,
      patch.closedAt !== undefined ? patch.closedAt : null,
      id,
      fromState,
    );
    if (result.changes === 0) {
      const row = await this.findById(id);
      return row && row.state !== fromState ? row : null;
    }
    return this.findById(id);
  }

  /**
   * 等待方消亡规则（§2 等待方生命周期规则①）：owner 獭被解散 →
   * 其名下 WAITING_OTTER 的 matter 自动转回 OPEN 待重派（每日扫描兜底发现）。
   * 返回受影响行数（0 = 无悬挂事项，正常态）。
   */
  async reopenForDissolvedOwner(otterId: string, now: string): Promise<number> {
    const result = this.db.prepare(`
      UPDATE matters SET
        state = 'OPEN', waiting_on = NULL, updated_at = ?
      WHERE owner_otter_id = ? AND state = 'WAITING_OTTER'
    `).run(now, otterId);
    return result.changes;
  }
}

