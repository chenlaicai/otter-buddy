/**
 * F20261027hwl1：工作详情报告——单件工作的成本拆分、参与者、轮次时间线。
 *  不存在的 workId 返回 null（controller 404），不返回演示对象。
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
  /** 调用证据（最新 N 条，按时间倒序） */
  invokeEvidence: WorkInvokeEvidence[];
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

    const traces = await this.repo.listTraces(workId);
    const traceIds = new Set(traces.map(t => t.traceId));

    // 拉归属视图后按 traceId 过滤（本工作的调用证据）
    const attributions = await this.repo.listInvokeAttributions({ limit: 20000 });
    const mine = attributions.filter(a => a.workId === workId || (a.traceId && traceIds.has(a.traceId)));

    const tokens: WorkTokenSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const participants = new Map<string, number>();
    const collect = (a: (typeof mine)[number]): WorkInvokeEvidence => {
      tokens.input += a.tokenUsageInput ?? 0;
      tokens.output += a.tokenUsageOutput ?? 0;
      tokens.cacheRead += a.tokenUsageCacheRead ?? 0;
      tokens.cacheWrite += a.tokenUsageCacheWrite ?? 0;
      tokens.totalTokens += (a.tokenUsageInput ?? 0) + (a.tokenUsageOutput ?? 0) + (a.tokenUsageCacheRead ?? 0) + (a.tokenUsageCacheWrite ?? 0);
      participants.set(a.otterId, (participants.get(a.otterId) ?? 0) + 1);
      return toEvidence(a);
    };
    const invokeEvidence: WorkInvokeEvidence[] = mine.slice(0, evidenceLimit).map(collect);

    return {
      work,
      tokens,
      participants: [...participants.entries()].map(([otterId, invokeCount]) => ({ otterId, invokeCount })),
      traces: traces.map(t => ({ traceId: t.traceId, boundAt: t.boundAt, boundVia: t.boundVia })),
      invokeEvidence,
      pricingAvailable: false,
    };
  }
}
