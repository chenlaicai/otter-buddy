/**
 * F20261027hwl1：工作账本只读报告——work-ledger 聚合（列表 + 覆盖率 + 未归属）。
 *
 * 总量守恒（特性文档）：所有真实调用 = 已归属工作 + 未归属；缺失 usage 的调用数
 * 另列，不当作零。token 主数字，金额本期无价格配置（pricingAvailable=false）。
 *
 * F20261027hwl1 复审 S1 修复：聚合入口从「listInvokeAttributions（LIMIT 截断后内存分桶）」
 * 改为 aggregateAttributionCounts（SQL 内全量 GROUP BY）——coverage/未归属口径从
 * 「最近 5000 条」回到全量，不受数据增长影响，列表与详情同守恒。
 */
import type { Logger } from "@usecases/ports/logger";
import type { WorkItem, WorkReviewRound } from "@entities/health/work-ledger";
import type { WorkLedgerRepository, WorkTokenAggregate } from "./work-ledger-repository";

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
  /** per-work usage 缺口（四分量全 null 的调用数——复审 A5：显式返回，不与真实零混淆） */
  usageGapCount: number;
}

export interface WorkLedgerReport {
  works: WorkReportItem[];
  /** 归属覆盖率（0-1）：已归属 invoke / 全部 invoke（全量口径——复审 S1） */
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

function aggToSummary(agg: WorkTokenAggregate): WorkTokenSummary {
  return {
    input: agg.input,
    output: agg.output,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
    totalTokens: agg.totalTokens,
  };
}

export class WorkLedgerReportBuilder {
  constructor(
    private readonly repo: WorkLedgerRepository,
    private readonly logger: Logger,
  ) {}

  async build(): Promise<WorkLedgerReport> {
    const works = await this.repo.listWorks();
    // 复审 S1：SQL 内全量聚合（无 LIMIT）——守恒口径不再随数据量漂移
    const agg = await this.repo.aggregateAttributionCounts();

    let usageGapTotal = agg.unassigned.usageGapCount;
    const items: WorkReportItem[] = works.map(w => {
      const a = agg.perWork.get(w.id);
      usageGapTotal += a?.tokens.usageGapCount ?? 0;
      return {
        workId: w.id,
        title: w.title,
        status: w.status,
        originKind: w.originKind,
        originId: w.originId,
        evidenceQuality: w.evidenceQuality,
        createdAt: w.createdAt,
        closedAt: w.closedAt,
        tokens: a ? aggToSummary(a.tokens) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        participants: a ? [...a.participants].map(otterId => ({ otterId })) : [],
        reviewRounds: w.reviewRounds,
        roundsRecorded: w.reviewRounds.length > 0,
        invokeCount: a?.tokens.invokeCount ?? 0,
        usageGapCount: a?.tokens.usageGapCount ?? 0,
      };
    });

    return {
      works: items,
      attributionCoverage: agg.total.invokeCount > 0 ? agg.total.attributedCount / agg.total.invokeCount : null,
      unassigned: {
        invokeCount: agg.unassigned.invokeCount,
        tokens: aggToSummary(agg.unassigned),
        unboundTraceCount: agg.unassigned.unboundTraceCount,
        noTraceCount: agg.unassigned.noTraceCount,
      },
      usageGapInvokeCount: usageGapTotal,
      // F20261027hwl1：本期货架零价格配置——只有显式可信配置才计算金额（特性文档「token 与金额」）
      pricingAvailable: false,
    };
  }
}
