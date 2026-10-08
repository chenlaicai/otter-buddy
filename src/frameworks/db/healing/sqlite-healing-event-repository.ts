import type Database from 'better-sqlite3';
import type { HealingEvent, HealingEventStats, HealingEventStatus, HealingResolution } from '@entities/healing/healing-event';
import type { HealingEventRepository, HealingEventBatchFilter, BatchResolveResult, BatchBindResult } from '@usecases/healing/healing-event-repository';
import { rowToHealingEvent, eventToRow, type HealingEventRow } from './healing-event-mapper';

export class SqliteHealingEventRepository implements HealingEventRepository {
  constructor(private readonly db: Database.Database) {}

  async create(event: HealingEvent): Promise<void> {
    const row = eventToRow(event);
    this.db.prepare(`
      INSERT INTO healing_events (
        id, message_id, conversation_id, otter_id, error_type, severity,
        description, suggestion, context, status, resolution, created_at, resolved_at, introduced_by_pr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.message_id, row.conversation_id, row.otter_id,
      row.error_type, row.severity, row.description, row.suggestion,
      row.context, row.status, row.resolution, row.created_at, row.resolved_at,
      row.introduced_by_pr,
    );
  }

  async findById(id: string): Promise<HealingEvent | null> {
    const row = this.db.prepare(
      'SELECT * FROM healing_events WHERE id = ?',
    ).get(id) as HealingEventRow | undefined;
    return row ? rowToHealingEvent(row) : null;
  }

  async findOpen(limit = 50): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    ).all('open', limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findAll(status: HealingEventStatus, limit = 50): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    ).all(status, limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findByConversation(conversationId: string, errorType?: string): Promise<HealingEvent[]> {
    // F20260903ah68 S3.5（mimo 审视焦点4）：可选 errorType 过滤——GateBanner 2s 轮询
    // 只消费 rate_limit 事件，过滤下推 SQL + idx_healing_events_conversation 索引命中
    const rows = errorType
      ? this.db.prepare(
          'SELECT * FROM healing_events WHERE conversation_id = ? AND error_type = ? ORDER BY created_at DESC',
        ).all(conversationId, errorType) as HealingEventRow[]
      : this.db.prepare(
          'SELECT * FROM healing_events WHERE conversation_id = ? ORDER BY created_at DESC',
        ).all(conversationId) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async findRecentByOtter(otterId: string, errorType: string, limit = 10): Promise<HealingEvent[]> {
    const rows = this.db.prepare(
      'SELECT * FROM healing_events WHERE otter_id = ? AND error_type = ? ORDER BY created_at DESC LIMIT ?',
    ).all(otterId, errorType, limit) as HealingEventRow[];
    return rows.map(rowToHealingEvent);
  }

  async updateStatus(id: string, status: HealingEventStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE healing_events SET status = ?, resolved_at = ? WHERE id = ?',
    ).run(status, status === 'resolved' || status === 'dismissed' ? now : null, id);
  }

  async resolve(id: string, resolution: HealingResolution): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE healing_events SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?',
    ).run('resolved', JSON.stringify(resolution), now, id);
  }

  async getStats(): Promise<HealingEventStats> {
    const statusRows = this.db.prepare(
      'SELECT status, COUNT(*) as cnt FROM healing_events GROUP BY status',
    ).all() as Array<{ status: string; cnt: number }>;

    const typeRows = this.db.prepare(
      "SELECT error_type, COUNT(*) as cnt FROM healing_events WHERE status = 'open' GROUP BY error_type",
    ).all() as Array<{ error_type: string; cnt: number }>;

    const severityRows = this.db.prepare(
      "SELECT severity, COUNT(*) as cnt FROM healing_events WHERE status = 'open' GROUP BY severity",
    ).all() as Array<{ severity: string; cnt: number }>;

    const stats: HealingEventStats = { open: 0, resolved: 0, dismissed: 0, byType: {}, bySeverity: {} };
    for (const row of statusRows) {
      if (row.status === 'open') stats.open = row.cnt;
      else if (row.status === 'resolved') stats.resolved = row.cnt;
      else if (row.status === 'dismissed') stats.dismissed = row.cnt;
    }
    for (const row of typeRows) stats.byType[row.error_type] = row.cnt;
    for (const row of severityRows) stats.bySeverity[row.severity] = row.cnt;

    return stats;
  }

  async autoStaleDismiss(staleDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    // F20261008hcpa（#1356 选 A）：severity <> 'high'——high 升级信号不被时间静默，
    // 走 ageOutHighAndNotify 独立通道（推 alert-registry 提醒后再 dismiss）。
    const result = this.db.prepare(`
      UPDATE healing_events SET status = 'dismissed', resolved_at = ?
      WHERE status = 'open' AND created_at < ? AND severity <> 'high'
    `).run(now, cutoff);
    return result.changes;
  }

  /** F20261008hcpa（#1356 选 A）：超龄 high open 事件「先取后置 dismissed」。
   *  返回被处置事件供调度层推 healing-alert-registry——high 即使超龄也须留痕提醒，
   *  不能无声消失（与 autoStaleDismiss 的静默语义分层）。同一事务内完成取+置，
   *  防「取到了但 dismiss 失败」致下轮重复提醒。 */
  async ageOutHighAndNotify(staleDays: number): Promise<HealingEvent[]> {
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    // 审视 D 修复：UPDATE ... RETURNING 原子取回「本进程实际 dismiss 的行」——
    // 跨进程双实例同时跑 age-out 时，后到者 WHERE status='open' 匹配 0 行、RETURNING 空，
    // 不会重复推送提醒（原 SELECT+UPDATE 两步不看 changes，两边都认为自己 dismiss 成功）。
    // better-sqlite3 同步事务保证同进程原子；数据面 UPDATE 本身幂等，此处修复的是提醒面重复。
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        UPDATE healing_events SET status = 'dismissed', resolved_at = ?
        WHERE status = 'open' AND severity = 'high' AND created_at < ?
        RETURNING *
      `).all(now, cutoff) as HealingEventRow[];
      return rows.map(rowToHealingEvent);
    })();
  }

  /** F20261008gfrc：批量闸的 high 探测——与 batchResolveByFilter 同 WHERE 语义，只 count。
   *  抽 buildBatchWhere 供两路复用，防止闸与更新面的判定漂移。 */
  async countByFilter(filter: HealingEventBatchFilter): Promise<number> {
    const { where, params } = this.buildBatchWhere(filter);
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
    ).get(...params) as { cnt: number };
    return row.cnt;
  }

  /** F20261008gfrc：batch WHERE 构建抽出（countByFilter / batchResolveByFilter 共用）
   *  #1271（F20261008hbbd）：新增 ruleId / boundIssue 两个过滤维度（batch_bind /收尾查询用）
   *  #1271：条件段抽子函数——语句数超 max-statements 25 上限，且新增维度与既有
   *  四维度同构，抽后两类各自演化不互相挤占预算 */
  private buildBatchWhere(filter: HealingEventBatchFilter): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const status = filter.status ?? 'open';
    clauses.push('status = ?');
    params.push(status);
    this.appendSimpleFilters(filter, clauses, params);
    this.appendStructuralFilters(filter, clauses, params);
    return { where: clauses.join(' AND '), params };
  }

  /** 简单四维度：errorType / createdBefore / createdAfter / severity（列直等/比较） */
  private appendSimpleFilters(
    filter: HealingEventBatchFilter,
    clauses: string[],
    params: unknown[],
  ): void {
    if (filter.errorType) {
      clauses.push('error_type = ?');
      params.push(filter.errorType);
    }
    if (filter.createdBefore) {
      clauses.push('created_at < ?');
      params.push(filter.createdBefore);
    }
    if (filter.createdAfter) {
      clauses.push('created_at > ?');
      params.push(filter.createdAfter);
    }
    if (filter.severity) {
      clauses.push('severity = ?');
      params.push(filter.severity);
    }
  }

  /** #1271（F20261008hbbd）结构化两维度：ruleId（context JSON 提取）/ boundIssue（归口列）
   *  ruleId Why json_valid 防御：context 列存疑形态（空串/非 JSON）时 json_extract 抛错会炸
   *  整个查询——先验合法性再提取，非法行归 NULL 不匹配（保守不误归口）
   *  boundIssue null 语义 = 未归口面（batch_bind 作用域）；非 null = 按 issue 收尾查询 */
  private appendStructuralFilters(
    filter: HealingEventBatchFilter,
    clauses: string[],
    params: unknown[],
  ): void {
    if (filter.ruleId) {
      clauses.push("json_valid(context) AND json_extract(context, '$.ruleId') = ?");
      params.push(filter.ruleId);
    }
    if (filter.boundIssue !== undefined) {
      if (filter.boundIssue === null) {
        clauses.push('bound_issue IS NULL');
      } else {
        clauses.push('bound_issue = ?');
        params.push(filter.boundIssue);
      }
    }
  }

  async batchResolveByFilter(
    filter: HealingEventBatchFilter,
    resolution: HealingResolution,
    options?: { limit?: number; dryRun?: boolean },
  ): Promise<BatchResolveResult> {
    const limit = options?.limit ?? 100;
    const dryRun = options?.dryRun ?? false;

    // F20261008gfrc：WHERE 构建抽入 buildBatchWhere（与 countByFilter 同语义）
    const { where, params } = this.buildBatchWhere(filter);

    // dryRun: 只返回匹配数
    if (dryRun) {
      const countRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };
      return { matched: countRow.cnt, resolved: 0, resolvedIds: [] };
    }

    // Why: 单事务保证 count + match + update 原子性
    const now = new Date().toISOString();
    const resolutionJson = JSON.stringify(resolution);
    const result = this.db.transaction(() => {
      const totalRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };

      const matchedRows = this.db.prepare(
        `SELECT id FROM healing_events WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params, limit) as Array<{ id: string }>;

      if (matchedRows.length === 0) return { matched: 0, resolved: 0, resolvedIds: [], truncated: false, totalMatched: totalRow.cnt };

      const ids = matchedRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      const updateResult = this.db.prepare(
        `UPDATE healing_events SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id IN (${placeholders})`,
      ).run(resolutionJson, now, ...ids);

      return {
        matched: ids.length,
        resolved: updateResult.changes,
        resolvedIds: ids,
        // Why: truncated 让调用方知道还有剩余未处置（100 上限截断）
        truncated: totalRow.cnt > ids.length,
        totalMatched: totalRow.cnt,
      };
    })();

    return result;
  }

  /** #1271（F20261008hbbd）：按 filter 批量归口到 GitHub issue（bind≠resolve）。
   *  照 RHI batchBindIssue 成熟模式（#1052 同类问题先例）：单事务 count+match+update 原子执行、
   *  LIMIT 100 单批、truncated/totalMatched 标志、dryRun 预览。
   *  语义边界（设计取舍见特性文档 F20261008hbbd）：
   *  - 只作用于未归口 open（status='open' AND bound_issue IS NULL）——已归口换绑属异质操作，
   *    走单条路径逐条判断（本期无批量换绑）
   *  - bind 后状态保持 open：归口是结构化认领非静默处置（#1361 层3「high 必须 bind_issue」
   *    恰要求此语义——bind 后在 issue 内讨论，修复合入后 batch_resolve + filterBoundIssue 收尾）
   *  - created_at ASC 先老后新：处置最久远优先（与 RHI first_seen ASC 同序口径）
   *  - high 不拦（与 batch_resolve 的 high 批量闸相反且有意为之）：归口把升级信号推向
   *    结构化跟踪面，静默的反面是 bind——两个批量动作的语义性质不同 */
  async batchBindIssue(
    filter: HealingEventBatchFilter,
    issueNumber: number,
    options?: { note?: string; limit?: number; dryRun?: boolean; now?: Date },
  ): Promise<BatchBindResult> {
    const limit = options?.limit ?? 100;
    const dryRun = options?.dryRun ?? false;
    const now = (options?.now ?? new Date()).toISOString();
    // Why 强制未归口面：调用方传错 filter 时宁拒不猜（防重复归口把 bound_issue 换掉）
    const effective: HealingEventBatchFilter = { ...filter, status: filter.status ?? 'open', boundIssue: null };

    const { where, params } = this.buildBatchWhere(effective);

    if (dryRun) {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };
      return { matched: row.cnt, bound: 0, boundIds: [], truncated: false, totalMatched: row.cnt };
    }

    return this.db.transaction(() => {
      const totalRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM healing_events WHERE ${where}`,
      ).get(...params) as { cnt: number };
      const matchedRows = this.db.prepare(
        `SELECT id FROM healing_events WHERE ${where} ORDER BY created_at ASC LIMIT ?`,
      ).all(...params, limit) as Array<{ id: string }>;
      if (matchedRows.length === 0) {
        return { matched: 0, bound: 0, boundIds: [], truncated: false, totalMatched: totalRow.cnt };
      }
      const ids = matchedRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      // Why note 不落列：bind 阶段事件未终结，resolution 是终态记录；归口说明写 context
      // 会污染事发快照——处置链留痕由 issue 侧承载（issue body/评论），这与 RHI 设计一致
      const bound = this.db.prepare(
        `UPDATE healing_events SET bound_issue = ?, bound_at = ? WHERE id IN (${placeholders})`,
      ).run(issueNumber, now, ...ids).changes;
      return {
        matched: ids.length,
        bound,
        boundIds: ids,
        truncated: totalRow.cnt > ids.length,
        totalMatched: totalRow.cnt,
      };
    })();
  }
}
