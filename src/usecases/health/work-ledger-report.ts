/**
 * F20261027hwl1：工作账本只读报告——work-ledger 聚合（列表 + 覆盖率 + 未归属）。
 *
 * 总量守恒（特性文档）：所有真实调用 = 已归属工作 + 未归属；缺失 usage 的调用数
 * 另列，不当作零。token 主数字，金额本期无价格配置（pricingAvailable=false）。
 */
import type { Logger } from "@usecases/ports/logger";
import type { WorkItem, WorkReviewRound } from "@entities/health/work-ledger";
import type { WorkLedgerRepository } from "./work-ledger-repository";

export interface WorkTokenSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface WorkReportItem {
  workId: string;
  title: string;
  status: WorkItem["status"];
  originKind: WorkItem["originKind"];
  originId: string | null;
  evidenceQuality: WorkItem["evidenceQuality"];
  createdAt: string;
  closedAt: string | null;
  tokens: WorkTokenSummary;
  /** 参与獭（独立 otter_id 去重；重启不新增） */
  participants: Array<{ otterId: string }>;
  /** 结构化轮次（未记录时 reviewRounds 为空数组 + roundsRecorded=false——UI 显示「未记录」） */
  reviewRounds: WorkReviewRound[];
  roundsRecorded: boolean;
  invokeCount: number;
}

export interface WorkLedgerReport {
  works: WorkReportItem[];
  /** 归属覆盖率（0-1）：已归属 invoke / 有 trace 的 invoke 总数 */
  attributionCoverage: number | null;
  /** 未归属调用的 token 合计（有 trace 但无绑定工作的 + 无 trace 的分开计） */
  unassigned: {
    invokeCount: number;
    tokens: WorkTokenSummary;
    /** 有 traceId 但 trace 未绑定任何工作的 invoke 数 */
    unboundTraceCount: number;
    /** 无 traceId 的 invoke 数（链改造前的历史调用） */
    noTraceCount: number;
  };
  /** 缺失 usage 的调用数（真实调用但四分量缺失——数据缺口，不当零） */
  usageGapInvokeCount: number;
  /** 本期金额参考可用性：false=未配置可信价格表，UI 显示「未配置参考价」 */
  pricingAvailable: boolean;
}

function emptySummary(): WorkTokenSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addInto(summary: WorkTokenSummary, row: { tokenUsageInput: number | null; tokenUsageOutput: number | null; tokenUsageCacheRead: number | null; tokenUsageCacheWrite: number | null }): void {
  summary.input += row.tokenUsageInput ?? 0;
  summary.output += row.tokenUsageOutput ?? 0;
  summary.cacheRead += row.tokenUsageCacheRead ?? 0;
  summary.cacheWrite += row.tokenUsageCacheWrite ?? 0;
  summary.totalTokens +=
    (row.tokenUsageInput ?? 0) + (row.tokenUsageOutput ?? 0) +
    (row.tokenUsageCacheRead ?? 0) + (row.tokenUsageCacheWrite ?? 0);
}

type AttributionRowLite = {
  workId: string | null;
  traceId: string | null;
  otterId: string;
  tokenUsageInput: number | null;
  tokenUsageOutput: number | null;
  tokenUsageCacheRead: number | null;
  tokenUsageCacheWrite: number | null;
};

/** 单条归属行分桶：有 workId 进工作桶，否则进未归属桶（含 trace 状态细分） */
function bucketRow(row: AttributionRowLite, byWork: Map<string, WorkReportItem>, participantIndex: Map<string, Set<string>>, unassigned: WorkLedgerReport["unassigned"]): "work" | "unassigned" {
  const item = row.workId ? byWork.get(row.workId) : undefined;
  if (item) {
    item.invokeCount++;
    addInto(item.tokens, row);
    if (!participantIndex.has(item.workId)) participantIndex.set(item.workId, new Set());
    participantIndex.get(item.workId)!.add(row.otterId);
    return "work";
  }
  unassigned.invokeCount++;
  addInto(unassigned.tokens, row);
  if (row.traceId) unassigned.unboundTraceCount++;
  else unassigned.noTraceCount++;
  return "unassigned";
}

export class WorkLedgerReportBuilder {
  constructor(
    private readonly repo: WorkLedgerRepository,
    private readonly logger: Logger,
  ) {}

  async build(): Promise<WorkLedgerReport> {
    const works = await this.repo.listWorks();
    const attributions = await this.repo.listInvokeAttributions();

    // invoke 按工作分桶 + 未归属分桶
    const byWork = new Map<string, WorkReportItem>();
    for (const w of works) {
      byWork.set(w.id, {
        workId: w.id,
        title: w.title,
        status: w.status,
        originKind: w.originKind,
        originId: w.originId,
        evidenceQuality: w.evidenceQuality,
        createdAt: w.createdAt,
        closedAt: w.closedAt,
        tokens: emptySummary(),
        participants: [],
        reviewRounds: w.reviewRounds,
        roundsRecorded: w.reviewRounds.length > 0,
        invokeCount: 0,
      });
    }
    const unassigned = { invokeCount: 0, tokens: emptySummary(), unboundTraceCount: 0, noTraceCount: 0 };
    let usageGap = 0;
    let attributedCount = 0;

    const participantIndex = new Map<string, Set<string>>();
    for (const row of attributions) {
      if (row.tokenUsageInput === null && row.tokenUsageOutput === null) usageGap++;
      if (bucketRow(row, byWork, participantIndex, unassigned) === "work") attributedCount++;
    }
    for (const [workId, set] of participantIndex) {
      const item = byWork.get(workId);
      if (item) item.participants = [...set].map(otterId => ({ otterId }));
    }

    return {
      works: [...byWork.values()],
      attributionCoverage: attributions.length > 0 ? attributedCount / attributions.length : null,
      unassigned,
      usageGapInvokeCount: usageGap,
      // F20261027hwl1：本期货架零价格配置——只有显式可信配置才计算金额（特性文档「token 与金额」）
      pricingAvailable: false,
    };
  }
}
