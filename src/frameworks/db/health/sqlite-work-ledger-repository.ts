/**
 * F20261027hwl1：工作账本 SQLite 仓库。
 *
 * 表结构见 schema.ts createWorkLedgerTables。归属派生核心：
 * invokes.metadata.traceId（JSON1 扩展 JSON_EXTRACT——better-sqlite3 内建支持）
 * JOIN work_item_traces.trace_id 得每 invoke 的 workId。
 * 不改写 invokes 原始行——账本是只读观测投影，撤销时删投影表即可。
 */
import type Database from "better-sqlite3";
import type {
  WorkItem,
  WorkItemTrace,
  WorkReviewRound,
  WorkTraceBoundVia,
} from "@entities/health/work-ledger";
import type {
  WorkLedgerRepository,
  WorkReportInvokeRow,
  WorkInvokeAttribution,
  WorkAttributionAggregate,
  WorkTokenAggregate,
} from "@usecases/health/work-ledger-repository";

interface WorkItemRow {
  id: string;
  title: string;
  origin_kind: string;
  origin_id: string | null;
  status: string;
  conversation_id: string | null;
  created_by_otter_id: string | null;
  review_rounds: string | null;
  evidence_quality: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  let rounds: WorkReviewRound[] = [];
  if (row.review_rounds) {
    try {
      const parsed = JSON.parse(row.review_rounds) as WorkReviewRound[];
      if (Array.isArray(parsed)) rounds = parsed;
    } catch { /* 脏数据降级为无轮次记录（显示「未记录」） */ }
  }
  return {
    id: row.id,
    title: row.title,
    originKind: row.origin_kind as WorkItem["originKind"],
    originId: row.origin_id,
    status: row.status as WorkItem["status"],
    conversationId: row.conversation_id,
    createdByOtterId: row.created_by_otter_id,
    reviewRounds: rounds,
    evidenceQuality: row.evidence_quality as WorkItem["evidenceQuality"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export class SqliteWorkLedgerRepository implements WorkLedgerRepository {
  constructor(private readonly db: Database.Database) {}

  async createWork(input: {
    id: string;
    title: string;
    originKind: WorkItem["originKind"];
    originId?: string | null;
    conversationId?: string | null;
    createdByOtterId?: string | null;
    evidenceQuality?: WorkItem["evidenceQuality"];
    createdAt: string;
  }): Promise<WorkItem> {
    const item: WorkItem = {
      id: input.id,
      title: input.title.trim(),
      originKind: input.originKind,
      originId: input.originId ?? null,
      status: "active",
      conversationId: input.conversationId ?? null,
      createdByOtterId: input.createdByOtterId ?? null,
      reviewRounds: [],
      evidenceQuality: input.evidenceQuality ?? "tracked",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      closedAt: null,
    };
    this.db.prepare(`
      INSERT INTO work_items (id, title, origin_kind, origin_id, status, conversation_id,
        created_by_otter_id, review_rounds, evidence_quality, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, item.title, item.originKind, item.originId, item.status, item.conversationId,
      item.createdByOtterId, JSON.stringify(item.reviewRounds), item.evidenceQuality,
      item.createdAt, item.updatedAt, item.closedAt,
    );
    return item;
  }

  async updateWorkStatus(workId: string, status: WorkItem["status"], closedAt: string | null): Promise<void> {
    this.db.prepare(`
      UPDATE work_items SET status = ?, closed_at = COALESCE(?, closed_at), updated_at = ? WHERE id = ?
    `).run(status, closedAt, new Date().toISOString(), workId);
  }

  async upsertReviewRound(workId: string, round: WorkReviewRound): Promise<void> {
    const work = await this.getWorkById(workId);
    if (!work) return;
    const idx = work.reviewRounds.findIndex(r => r.roundNo === round.roundNo);
    if (idx >= 0) work.reviewRounds[idx] = { ...work.reviewRounds[idx], ...round };
    else work.reviewRounds.push(round);
    // 轮次数按 roundNo 排序保持稳定展示
    work.reviewRounds.sort((a, b) => a.roundNo - b.roundNo);
    this.db.prepare("UPDATE work_items SET review_rounds = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(work.reviewRounds), new Date().toISOString(), workId);
  }

  async bindTrace(workId: string, traceId: string, boundVia: WorkTraceBoundVia, boundAt: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO work_item_traces (work_id, trace_id, bound_at, bound_via) VALUES (?, ?, ?, ?)
      ON CONFLICT (work_id, trace_id) DO NOTHING
    `).run(workId, traceId, boundAt, boundVia);
  }

  async setActiveWork(conversationId: string, workId: string, anchoredEntryId: string | null, updatedAt: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversation_active_work (conversation_id, work_id, anchored_entry_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO UPDATE SET work_id = excluded.work_id,
        anchored_entry_id = excluded.anchored_entry_id, updated_at = excluded.updated_at
    `).run(conversationId, workId, anchoredEntryId, updatedAt);
  }

  async getWorkById(workId: string): Promise<WorkItem | null> {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(workId) as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  async listWorks(limit?: number): Promise<WorkItem[]> {
    const rows = this.db.prepare(
      "SELECT * FROM work_items ORDER BY updated_at DESC LIMIT ?",
    ).all(limit ?? 200) as WorkItemRow[];
    return rows.map(rowToWorkItem);
  }

  async findWorksByOrigin(originKind: WorkItem["originKind"], originId: string): Promise<WorkItem[]> {
    const rows = this.db.prepare(
      "SELECT * FROM work_items WHERE origin_kind = ? AND origin_id = ? ORDER BY created_at DESC",
    ).all(originKind, originId) as WorkItemRow[];
    return rows.map(rowToWorkItem);
  }

  async findWorkByTrace(traceId: string): Promise<WorkItem | null> {
    const row = this.db.prepare(`
      SELECT w.* FROM work_items w
      JOIN work_item_traces t ON t.work_id = w.id
      WHERE t.trace_id = ?
      ORDER BY t.bound_at DESC LIMIT 1
    `).get(traceId) as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  async listTraces(workId: string): Promise<WorkItemTrace[]> {
    const rows = this.db.prepare(
      "SELECT work_id, trace_id, bound_at, bound_via FROM work_item_traces WHERE work_id = ? ORDER BY bound_at",
    ).all(workId) as Array<{ work_id: string; trace_id: string; bound_at: string; bound_via: string }>;
    return rows.map(r => ({ workId: r.work_id, traceId: r.trace_id, boundAt: r.bound_at, boundVia: r.bound_via as WorkTraceBoundVia }));
  }

  async getActiveWork(conversationId: string): Promise<WorkItem | null> {
    const row = this.db.prepare(`
      SELECT w.* FROM work_items w
      JOIN conversation_active_work c ON c.work_id = w.id
      WHERE c.conversation_id = ?
    `).get(conversationId) as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  async listInvokeAttributions(options?: { invokedAfterIso?: string; limit?: number }): Promise<Array<WorkReportInvokeRow & { workId: string | null }>> {
    const limit = options?.limit ?? 5000;
    const after = options?.invokedAfterIso;
    // Why: traceId 从 metadata JSON 派生（JSON_EXTRACT）——归属是派生关系不是写时冗余，
    // avoids 双写漂移；invokes 原始行永不被账本改写。
    // F20261027hwl1 复审 S1：本方法不再是报告聚合入口（先截断后聚合产生窗口偏置）——
    // 报告走 aggregateAttributionCounts / listInvokesByWork；此处保留小窗口逐行证据场景。
    const sql = `
      SELECT i.id AS invoke_id, i.conversation_id, i.otter_id, i.status, i.started_at,
        i.token_usage_input, i.token_usage_output, i.token_usage_cache_read, i.token_usage_cache_write,
        JSON_EXTRACT(i.metadata, '$.traceId') AS trace_id,
        wit.work_id AS work_id
      FROM invokes i
      LEFT JOIN work_item_traces wit ON wit.trace_id = JSON_EXTRACT(i.metadata, '$.traceId')
      ${after ? "WHERE i.started_at > ?" : ""}
      ORDER BY i.started_at DESC
      LIMIT ?
    `;
    const rows = (after
      ? this.db.prepare(sql).all(after, limit)
      : this.db.prepare(sql).all(limit)) as Array<{
      invoke_id: string; conversation_id: string; otter_id: string; status: string; started_at: string;
      token_usage_input: number | null; token_usage_output: number | null;
      token_usage_cache_read: number | null; token_usage_cache_write: number | null;
      trace_id: string | null; work_id: string | null;
    }>;
    return rows.map(r => ({
      invokeId: r.invoke_id,
      conversationId: r.conversation_id,
      otterId: r.otter_id,
      status: r.status,
      startedAt: r.started_at,
      tokenUsageInput: r.token_usage_input,
      tokenUsageOutput: r.token_usage_output,
      tokenUsageCacheRead: r.token_usage_cache_read,
      tokenUsageCacheWrite: r.token_usage_cache_write,
      traceId: r.trace_id,
      workId: r.work_id,
    }));
  }

  /** F20261027hwl1 复审 S1：全量归属聚合（SQL 内 GROUP BY，无 LIMIT）。
   *  守恒：sum(perWork.tokens) + unassigned.tokens 的 totalTokens = 全部 invokes 四分量总和。
   *  usage 缺口（四分量全 null）按 per-work usageGapCount / 未归属桶同样显式计出，不当零。 */
  async aggregateAttributionCounts(): Promise<WorkAttributionAggregate> {
    const sql = `
      SELECT wit.work_id AS work_id,
        COUNT(*) AS invoke_count,
        SUM(COALESCE(i.token_usage_input, 0)) AS input_sum,
        SUM(COALESCE(i.token_usage_output, 0)) AS output_sum,
        SUM(COALESCE(i.token_usage_cache_read, 0)) AS cache_read_sum,
        SUM(COALESCE(i.token_usage_cache_write, 0)) AS cache_write_sum,
        SUM(CASE WHEN i.token_usage_input IS NULL AND i.token_usage_output IS NULL THEN 1 ELSE 0 END) AS usage_gap,
        SUM(CASE WHEN JSON_EXTRACT(i.metadata, '$.traceId') IS NOT NULL THEN 1 ELSE 0 END) AS has_trace
      FROM invokes i
      LEFT JOIN work_item_traces wit ON wit.trace_id = JSON_EXTRACT(i.metadata, '$.traceId')
      GROUP BY wit.work_id
    `;
    const rows = this.db.prepare(sql).all() as Array<{
      work_id: string | null; invoke_count: number;
      input_sum: number | null; output_sum: number | null; cache_read_sum: number | null; cache_write_sum: number | null;
      usage_gap: number; has_trace: number;
    }>;
    const perWork: WorkAttributionAggregate["perWork"] = new Map();
    const unassigned = emptyUnassigned();
    let attributedCount = 0;
    for (const r of rows) {
      const agg = toAggregate(r);
      if (!r.work_id) {
        addToUnassigned(unassigned, agg, r.has_trace ?? 0);
        continue;
      }
      attributedCount += r.invoke_count;
      perWork.set(r.work_id, { tokens: agg, participants: new Set<string>() });
    }
    // 参与獭：per-work 的独立 otter 集（SQL 单独拉，行数=绑定 trace 的 invoke 数，量级可控）
    const participants = this.db.prepare(`
      SELECT wit.work_id AS work_id, i.otter_id AS otter_id
      FROM invokes i
      JOIN work_item_traces wit ON wit.trace_id = JSON_EXTRACT(i.metadata, '$.traceId')
      GROUP BY wit.work_id, i.otter_id
    `).all() as Array<{ work_id: string; otter_id: string }>;
    for (const p of participants) {
      const entry = perWork.get(p.work_id);
      if (entry) entry.participants.add(p.otter_id);
    }
    const totalInvokeCount = rows.reduce((acc, r) => acc + r.invoke_count, 0);
    return { perWork, unassigned, total: { invokeCount: totalInvokeCount, attributedCount } };
  }

  /** F20261027hwl1 复审 S1：按 work 的 trace 集合在 SQL 内直接过滤（详情页数据源）。
   *  不走全表 LIMIT——早期 invoke 不会被窗口挤出；证据列表 evidenceLimit 截断时
   *  由调用方（报告层）返回 truncatedCount，token 汇总仍全量。 */
  async listInvokesByWork(workId: string, options?: { evidenceLimit?: number }): Promise<WorkInvokeAttribution[]> {
    const evidenceLimit = options?.evidenceLimit ?? 50;
    // 证据视图：最新 N 条（时间倒序）+ 该 work 全部 invoke 的总数由报告层单独取
    const sql = `
      SELECT i.id AS invoke_id, i.conversation_id, i.otter_id, i.status, i.started_at,
        i.token_usage_input, i.token_usage_output, i.token_usage_cache_read, i.token_usage_cache_write,
        JSON_EXTRACT(i.metadata, '$.traceId') AS trace_id,
        wit.work_id AS work_id
      FROM invokes i
      JOIN work_item_traces wit ON wit.trace_id = JSON_EXTRACT(i.metadata, '$.traceId')
      WHERE wit.work_id = ?
      ORDER BY i.started_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(workId, evidenceLimit) as Array<{
      invoke_id: string; conversation_id: string; otter_id: string; status: string; started_at: string;
      token_usage_input: number | null; token_usage_output: number | null;
      token_usage_cache_read: number | null; token_usage_cache_write: number | null;
      trace_id: string | null; work_id: string | null;
    }>;
    return rows.map(r => ({
      invokeId: r.invoke_id,
      conversationId: r.conversation_id,
      otterId: r.otter_id,
      status: r.status,
      startedAt: r.started_at,
      tokenUsageInput: r.token_usage_input,
      tokenUsageOutput: r.token_usage_output,
      tokenUsageCacheRead: r.token_usage_cache_read,
      tokenUsageCacheWrite: r.token_usage_cache_write,
      traceId: r.trace_id,
      workId: r.work_id,
    }));
  }

  /** F20261027hwl1 复审 S1/A5：按 work 全量 invoke 数（truncatedCount 计算） */
  async countInvokesByWork(workId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM invokes i
      JOIN work_item_traces wit ON wit.trace_id = JSON_EXTRACT(i.metadata, '$.traceId')
      WHERE wit.work_id = ?
    `).get(workId) as { c: number };
    return row.c;
  }
}

/** F20261027hwl1 复审 S1：聚合行的四分量结构化（complexity 守卫拆出） */
interface AggregateSqlRow {
  work_id: string | null; invoke_count: number;
  input_sum: number | null; output_sum: number | null; cache_read_sum: number | null; cache_write_sum: number | null;
  usage_gap: number; has_trace: number;
}

function toAggregate(r: AggregateSqlRow): WorkTokenAggregate {
  return {
    input: r.input_sum ?? 0, output: r.output_sum ?? 0,
    cacheRead: r.cache_read_sum ?? 0, cacheWrite: r.cache_write_sum ?? 0,
    totalTokens: (r.input_sum ?? 0) + (r.output_sum ?? 0) + (r.cache_read_sum ?? 0) + (r.cache_write_sum ?? 0),
    invokeCount: r.invoke_count,
    usageGapCount: r.usage_gap,
  };
}

function emptyUnassigned(): WorkAttributionAggregate["unassigned"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, invokeCount: 0, usageGapCount: 0, unboundTraceCount: 0, noTraceCount: 0 };
}

function addToUnassigned(target: WorkAttributionAggregate["unassigned"], agg: WorkTokenAggregate, hasTrace: number): void {
  target.input += agg.input; target.output += agg.output;
  target.cacheRead += agg.cacheRead; target.cacheWrite += agg.cacheWrite;
  target.totalTokens += agg.totalTokens;
  target.invokeCount += agg.invokeCount;
  target.usageGapCount += agg.usageGapCount;
  target.unboundTraceCount += hasTrace;
  target.noTraceCount += agg.invokeCount - hasTrace;
}
