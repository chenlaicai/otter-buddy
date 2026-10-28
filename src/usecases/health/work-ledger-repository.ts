/**
 * F20261027hwl1：工作账本仓库端口（usecases 层接口）。
 *
 * 只读投影 + 确定性绑定的存储底座。写路径仅三种：
 * track_work 工具（start/resume/complete/cancel/review_round）、
 * 历史归集（inferred-historical，一次性）、binder 绑定（artifact/matter 证据）。
 * 读路径：账本报告（works + coverage + unassigned）与详情。
 */
import type {
  WorkItem,
  WorkItemTrace,
  WorkReviewRound,
  WorkTraceBoundVia,
} from "@entities/health/work-ledger";

export interface WorkReportInvokeRow {
  invokeId: string;
  traceId: string | null;
  otterId: string;
  conversationId: string;
  startedAt: string;
  status: string;
  tokenUsageInput: number | null;
  tokenUsageOutput: number | null;
  tokenUsageCacheRead: number | null;
  tokenUsageCacheWrite: number | null;
}

/** F20261027hwl1 复审 S1：单行归属视图（SQL 内按 work 过滤后的详情页数据源） */
export interface WorkInvokeAttribution extends WorkReportInvokeRow {
  workId: string | null;
}

/** per-work token 四分量聚合（SQL 内全量算出，不受 LIMIT 窗口影响） */
export interface WorkTokenAggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  invokeCount: number;
  /** 四分量全 null 的调用数（per-work usage 缺口——复审 A5） */
  usageGapCount: number;
}

/** 全量归属聚合结果：守恒式 sum(perWork) + unassigned = total */
export interface WorkAttributionAggregate {
  perWork: Map<string, { tokens: WorkTokenAggregate; participants: Set<string> }>;
  unassigned: WorkTokenAggregate & { unboundTraceCount: number; noTraceCount: number };
  total: { invokeCount: number; attributedCount: number };
}

export interface WorkLedgerRepository {
  // ── 写路径 ──
  createWork(input: {
    id: string;
    title: string;
    originKind: WorkItem["originKind"];
    originId?: string | null;
    conversationId?: string | null;
    createdByOtterId?: string | null;
    evidenceQuality?: WorkItem["evidenceQuality"];
    createdAt: string;
  }): Promise<WorkItem>;

  updateWorkStatus(workId: string, status: WorkItem["status"], closedAt: string | null): Promise<void>;

  /** 追加/更新检视轮次（roundNo 为键 upsert——同一轮的 state 推进覆盖前值） */
  upsertReviewRound(workId: string, round: WorkReviewRound): Promise<void>;

  /** trace→work 绑定（幂等：PK 冲突忽略） */
  bindTrace(workId: string, traceId: string, boundVia: WorkTraceBoundVia, boundAt: string): Promise<void>;

  /** conversation 的显式 resume 锚点（upsert） */
  setActiveWork(conversationId: string, workId: string, anchoredEntryId: string | null, updatedAt: string): Promise<void>;

  // ── 读路径 ──
  getWorkById(workId: string): Promise<WorkItem | null>;
  listWorks(limit?: number): Promise<WorkItem[]>;
  findWorksByOrigin(originKind: WorkItem["originKind"], originId: string): Promise<WorkItem[]>;
  /** trace → 已绑定 work（归属主查询；一个 trace 至多一个当前工作） */
  findWorkByTrace(traceId: string): Promise<WorkItem | null>;
  listTraces(workId: string): Promise<WorkItemTrace[]>;
  getActiveWork(conversationId: string): Promise<WorkItem | null>;

  /**
   * 拉取全部 invokes 的归属关联视图（批量）——报告聚合的单一数据源。
   * 每行含 metadata.traceId（JSON 解析后）与已绑定 workId（JOIN work_item_traces）。
   * invokedAfterIso 可选：增量拉取（报告窗口控制）。
   * F20261027hwl1 复审 S1 修复：本方法不再作为报告聚合入口（先截断后聚合产生窗口偏置）；
   * 列表报告改用 aggregateAttributionCounts（SQL 内全量聚合），详情报告用
   * listInvokesByWork（SQL 内按 work 过滤）。本方法保留给需要逐行证据的小窗口场景。
   */
  listInvokeAttributions(options?: { invokedAfterIso?: string; limit?: number }): Promise<Array<WorkReportInvokeRow & { workId: string | null }>>;

  /**
   * F20261027hwl1 复审 S1：全量归属聚合（无 LIMIT，SQL 内聚合）。
   * 返回 per-work token 四分量/invoke 数/参与獭 + 未归属桶 + 总量。
   * 守恒语义：sum(workTokens) + unassigned = total，不受数据量增长影响。
   */
  aggregateAttributionCounts(): Promise<WorkAttributionAggregate>;

  /**
   * F20261027hwl1 复审 S1：按 work 的 trace 集合在 SQL 内拉全量归属行（详情页数据源）。
   * 不经过全表 LIMIT——工作再老/再久，早期 invoke 不丢。
   */
  listInvokesByWork(workId: string, options?: { evidenceLimit?: number }): Promise<WorkInvokeAttribution[]>;

  /** F20261027hwl1 复审 S1/A5：按 work 全量 invoke 计数（truncatedCount 计算用） */
  countInvokesByWork(workId: string): Promise<number>;
}
