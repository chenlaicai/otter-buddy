import type Database from 'better-sqlite3';
import type { Matter, MatterQueryFilter } from '@entities/matter/matter';
import type { MatterRepository } from '@usecases/matter/matter-repository';
import type { MatterSweepStall, MatterSweepStalledRow } from '@usecases/matter/matter-sweep';

/**
 * Matters 的 SQLite 实现（F20261006mtlp P1；F20261008mlp3 P3：扫描升格扩展）。
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
   * F20261006mtlp §2 等待方生命周期规则①（审视修订：判定键 = waiting_on 指向的獭，
   * 补 owner 键双扫——消灭悬挂优先）：**waiting_on 指向的獭**（或 owner）被解散 →
   * 其名下 WAITING_OTTER 的 matter 自动转回 OPEN 待重派（每日扫描兜底发现）。
   * 返回受影响行数（0 = 无悬挂事项，正常态）。
   */
  async reopenForDissolvedOwner(otterId: string, now: string): Promise<number> {
    // 判定优先级：waiting_on 显式指向 > owner 兜底（仅 waiting_on 为 NULL 时）。
    // waiting_on=otter:<B>（B 健在）时 owner 消亡不误重开——等待方还在干活；
    // waiting_on 为 NULL 的老数据/认领路径由 owner 键兜底。
    const result = this.db.prepare(`
      UPDATE matters SET
        state = 'OPEN', waiting_on = NULL, updated_at = ?
      WHERE state = 'WAITING_OTTER'
        AND (waiting_on = ? OR (waiting_on IS NULL AND owner_otter_id = ?))
    `).run(now, `otter:${otterId}`, otterId);
    return result.changes;
  }

  /**
   * F20261008mlp3 P3：跨对话停滞扫描（未闭环扫描升格——确定性数据源）。
   * 停滞定义（方案 §7 P3）：OPEN 无人认领 / WAITING_PARTNER 积压——跨日未收尾（24h 基准）。
   * 只读；调用方（三省吾身大獭）负责提醒，不做自动处置。
   */
  async stalledOpen(nowIso: string, stallThresholdIso: string, limit = 200): Promise<MatterSweepStall[]> {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, title, owner_otter_id, level, state,
             waiting_on, waiting_for, created_at, updated_at
      FROM matters
      WHERE state = 'OPEN'
         OR (state = 'WAITING_PARTNER' AND updated_at <= ?)
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(stallThresholdIso, limit) as Array<Pick<MatterRow,
      'id' | 'conversation_id' | 'title' | 'owner_otter_id' | 'level' | 'state' | 'waiting_on' | 'waiting_for' | 'created_at' | 'updated_at'>>;
    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      title: r.title,
      ownerOtterId: r.owner_otter_id,
      level: (r.level as Matter['level']) ?? null,
      state: r.state as Matter['state'],
      waitingOn: r.waiting_on,
      waitingFor: r.waiting_for,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stalledHours: Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(r.updated_at)) / 3_600_000)),
    }));
  }

  /**
   * F20261008mlp3 P3：漏登记的 L2 待裁决项发现（准入路径 3 兜底——可执行化）。
   * 严重3修复：①SQL 排除已登记 matter（LEFT JOIN origin_message_id——"漏登记"语义落进查询）；
   * ②输出带 originMessageId + registeredMatterId，调用方按去重键判定（不用肉眼甄别）；
   * ③expects_partner_decision 未持久化（schema 无此列），SQL 层面无法区分 L2 拍板与
   * 例行交棒——兜底半径如实声明为「yield-to-user 未登记增量」，L2 甄别留给调用方
   * （payload 含 brief 或 reason 含拍板语义时权重更高）。只读；调用方决定是否补登记。
   */
  async unregisteredYieldsToUser(sinceIso: string, limit = 100): Promise<MatterSweepStalledRow[]> {
    const rows = this.db.prepare(`
      SELECT e.id, e.conversation_id, e.created_at, e.sender_id, e.sender_name, e.yield_targets, e.body,
             m.id AS registered_matter_id, m.origin_message_id AS matter_origin
      FROM entries e
      LEFT JOIN matters m ON m.origin_message_id = e.id
      WHERE e.entry_type = 'yield'
        AND e.created_at >= ?
        AND e.yield_targets LIKE '%"user"%'
        AND m.id IS NULL
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(sinceIso, limit) as Array<{
      id: string; conversation_id: string; created_at: string;
      sender_id: string | null; sender_name: string; yield_targets: string | null; body: string | null;
      registered_matter_id: string | null; matter_origin: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      senderId: r.sender_id,
      senderName: r.sender_name,
      yieldTargets: r.yield_targets,
      body: r.body,
      // 去重键：matter 登记时 origin_message_id = yield entry id（P1 准入路径 1 锁定）
      originMessageId: r.id,
      registeredMatterId: r.registered_matter_id,
    }));
  }
}
