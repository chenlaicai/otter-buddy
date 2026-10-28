/**
 * F20261027hwl1：工作账本绑定 usecase——track_write 端口与证据绑定的写路径。
 *
 * 归属原则（特性文档「归属规则」）：
 * - 确定性优先：trace 关系 + 明确工具/资源证据；不做 LLM 猜测归属。
 * - 每次新的用户点火链默认不继承旧工作（防新主题误记）；只有显式 resume
 *   或 feature/matter 证据才绑定；链内 hop 经共享 traceId 自动继承。
 * - 失败不阻断业务 invoke（观测投影），但暴露 telemetry gap（log）。
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "@usecases/ports/logger";
import type { WorkItem, WorkReviewRound } from "@entities/health/work-ledger";
import type { WorkLedgerRepository } from "./work-ledger-repository";

export interface TrackWorkStartInput {
  conversationId: string;
  otterId: string;
  /** 当前链 traceId（工具上下文注入——无 trace 时拒绝 start，归属无从谈起） */
  traceId: string;
  /** 独立目标一句话 title */
  title: string;
  originKind?: WorkItem["originKind"];
  originId?: string | null;
  /** 触发锚点 entry（审计） */
  anchoredEntryId?: string | null;
}

export interface TrackWorkResumeInput {
  conversationId: string;
  otterId: string;
  workId: string;
  traceId: string;
  anchoredEntryId?: string | null;
}

export class WorkLedgerBinder {
  constructor(
    private readonly repo: WorkLedgerRepository,
    private readonly logger: Logger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** start：新工作 + trace 绑定 + conversation 锚点 */
  async start(input: TrackWorkStartInput): Promise<WorkItem> {
    const work = await this.repo.createWork({
      id: randomUUID(),
      title: input.title,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      conversationId: input.conversationId,
      createdByOtterId: input.otterId,
      evidenceQuality: "tracked",
      createdAt: this.now(),
    });
    await this.repo.bindTrace(work.id, input.traceId, "track_work", this.now());
    await this.repo.setActiveWork(input.conversationId, work.id, input.anchoredEntryId ?? null, this.now());
    this.logger.info("[work-ledger] work started", { workId: work.id, title: work.title, traceId: input.traceId, conversationId: input.conversationId });
    return work;
  }

  /**
   * resume：已有工作续接新链——绑定新 traceId 并刷新 conversation 锚点。
   * 跨对话续接：conversationId 可以与工作创建时的不同（工作跨对话）。
   */
  async resume(input: TrackWorkResumeInput): Promise<WorkItem | null> {
    const work = await this.repo.getWorkById(input.workId);
    if (!work) return null;
    if (work.status === "cancelled") return null;
    await this.repo.bindTrace(work.id, input.traceId, "track_work", this.now());
    await this.repo.setActiveWork(input.conversationId, work.id, input.anchoredEntryId ?? null, this.now());
    this.logger.info("[work-ledger] work resumed", { workId: work.id, traceId: input.traceId, conversationId: input.conversationId });
    return work;
  }

  /** complete/cancel：只记工作投影状态，不越权闭合 matter/PR */
  async complete(workId: string, status: "delivered" | "merged" | "closed"): Promise<WorkItem | null> {
    const work = await this.repo.getWorkById(workId);
    if (!work) return null;
    await this.repo.updateWorkStatus(workId, status, this.now());
    this.logger.info("[work-ledger] work completed", { workId, status });
    return { ...work, status, closedAt: this.now() };
  }

  async cancel(workId: string): Promise<WorkItem | null> {
    const work = await this.repo.getWorkById(workId);
    if (!work) return null;
    await this.repo.updateWorkStatus(workId, "cancelled", this.now());
    this.logger.info("[work-ledger] work cancelled", { workId });
    return { ...work, status: "cancelled", closedAt: this.now() };
  }

  /** 检视轮次结构化留痕（started/awaiting-fix/delta-review/passed 推进；invoke 证据随轮次保存） */
  async recordReviewRound(workId: string, round: WorkReviewRound): Promise<void> {
    await this.repo.upsertReviewRound(workId, round);
  }
}
