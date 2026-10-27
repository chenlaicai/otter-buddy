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
   */
  listInvokeAttributions(options?: { invokedAfterIso?: string; limit?: number }): Promise<Array<WorkReportInvokeRow & { workId: string | null }>>;
}
