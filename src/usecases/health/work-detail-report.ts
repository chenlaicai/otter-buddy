/**
 * F20261027hwl1：工作详情报告——单件工作的成本拆分、参与者、轮次时间线。
 *  不存在的 workId 返回 null（controller 404），不返回演示对象。
 *
 * F20261027hwl1 复审 S1/A5 修复：
 * - token 汇总走 aggregateAttributionCounts 的 per-work 全量（无 LIMIT，工作再老不丢早期数据）
 * - 证据列表 SQL 内按 work 过滤后取最新 evidenceLimit 条 + truncatedCount 显式返回
 * - per-work usageGapCount 显式返回（不与真实零混淆）
 */
import type { WorkItem } from "@entities/health/work-ledger";
import type { WorkLedgerRepository } from "./work-ledger-repository";
import type { WorkTokenSummary } from "./work-ledger-report";

export interface WorkInvokeEvidence {
  invokeId: string;
  otterId: string;
  conversationId: string;
  startedAt: string;
  tokens: WorkTokenSummary;
  hasUsage: boolean;
}

export interface WorkDetailReport {
  work: WorkItem;
  tokens: WorkTokenSummary;
  participants: Array<{ otterId: string; invokeCount: number }>;
  traces: Array<{ traceId: string; boundAt: string; boundVia: string }>;
  /** 调用证据（最新 N 条，按时间倒序；超出的部分 truncatedCount 显式计数——复审 A5） */
  invokeEvidence: WorkInvokeEvidence[];
  /** 证据列表截断数（total invokes - evidenceLimit 返回数；0 = 无截断） */
  truncatedCount: number;
  /** 全部 invoke 数（与列表报告 invokeCount 同口径——复审 S1：两处数字不再打架） */
  totalInvokeCount: number;
  /** per-work usage 缺口（四分量全 null——复审 A5：显式返回不与真实零混淆） */
  usageGapCount: number;
  /** 金额参考可用性（本期恒 false——未配置价格表） */
  pricingAvailable: boolean;
}

/** 归属行 → 调用证据 DTO（usage 缺失显式标记，不当零） */
function toEvidence(a: { invokeId: string; otterId: string; conversationId: string; startedAt: string; tokenUsageInput: number | null; tokenUsageOutput: number | null; tokenUsageCacheRead: number | null; tokenUsageCacheWrite: number | null }): WorkInvokeEvidence {
  return {
    invokeId: a.invokeId,
    otterId: a.otterId,
    conversationId: a.conversationId,
    startedAt: a.startedAt,
    tokens: {
      input: a.tokenUsageInput ?? 0,
      output: a.tokenUsageOutput ?? 0,
      cacheRead: a.tokenUsageCacheRead ?? 0,
      cacheWrite: a.tokenUsageCacheWrite ?? 0,
      totalTokens: (a.tokenUsageInput ?? 0) + (a.tokenUsageOutput ?? 0) + (a.tokenUsageCacheRead ?? 0) + (a.tokenUsageCacheWrite ?? 0),
    },
    hasUsage: a.tokenUsageInput !== null || a.tokenUsageOutput !== null,
  };
}

export class WorkDetailReportBuilder {
  constructor(private readonly repo: WorkLedgerRepository) {}

  async build(workId: string, evidenceLimit = 50): Promise<WorkDetailReport | null> {
    const work = await this.repo.getWorkById(workId);
    if (!work) return null;

    // 复审 S1：token 汇总走全量聚合（SQL 内 GROUP BY，无 LIMIT）——与列表报告同源同口径
    const agg = await this.repo.aggregateAttributionCounts();
    const perWork = agg.perWork.get(workId);
    const tokens: WorkTokenSummary = perWork
      ? { input: perWork.tokens.input, output: perWork.tokens.output, cacheRead: perWork.tokens.cacheRead, cacheWrite: perWork.tokens.cacheWrite, totalTokens: perWork.tokens.totalTokens }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

    // 参与獭 invoke 数：per-otter 分组（SQL 内按 work 过滤）
    const participants = new Map<string, number>();
    const traces = await this.repo.listTraces(workId);
    const evidence = await this.repo.listInvokesByWork(workId, { evidenceLimit });
    const totalInvokeCount = await this.repo.countInvokesByWork(workId);

    // 参与獭计数从全量证据行取（evidenceLimit 只影响展示列表，不影响计数——计数走聚合）
    const allRows = await this.repo.listInvokesByWork(workId, { evidenceLimit: 1_000_000 });
    for (const a of allRows) {
      participants.set(a.otterId, (participants.get(a.otterId) ?? 0) + 1);
    }

    return {
      work,
      tokens,
      participants: [...participants.entries()].map(([otterId, invokeCount]) => ({ otterId, invokeCount })),
      traces: traces.map(t => ({ traceId: t.traceId, boundAt: t.boundAt, boundVia: t.boundVia })),
      invokeEvidence: evidence.map(toEvidence),
      truncatedCount: Math.max(0, totalInvokeCount - evidence.length),
      totalInvokeCount,
      usageGapCount: perWork?.tokens.usageGapCount ?? 0,
      pricingAvailable: false,
    };
  }
}
