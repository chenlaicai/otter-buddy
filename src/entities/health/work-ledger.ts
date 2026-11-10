/** F20261027hwl1：工作账本领域类型——「一件工作」的成本归集单位。
 *
 *  工作定义（特性文档）：有独立目标、边界和结束状态的一次工作承诺。
 *  一段对话可有多件工作；一件工作可跨对话。PR 是交付物之一，不等于工作。
 */

/** 工作来源 */
export type WorkOriginKind = "feature" | "matter" | "manual" | "inferred-historical";

/** 工作投影状态（只记投影状态，不越权闭合 matter/PR） */
export type WorkStatus = "active" | "delivered" | "merged" | "closed" | "cancelled";

/** 证据质量：tracked=结构化绑定（trace 关系在案）；historical-partial=历史只读归集，不可当精确账 */
export type WorkEvidenceQuality = "tracked" | "historical-partial";

/** 检视轮次状态；completed 为 yield 自动采集的完成轮次，其余为既有历史状态 */
export type WorkReviewRoundState = "reviewing" | "awaiting-fix" | "delta-review" | "passed" | "open-unknown" | "completed";

/** 检视/复核轮次；新数据由检视者完成 yield 时按 invoke 自动追加 */
export interface WorkReviewRound {
  roundNo: number;
  reviewerOtterId: string;
  state: WorkReviewRoundState;
  /** 轮次开启时的 invoke 证据（reviewer 首次链活动） */
  startedInvokeId?: string | null;
  /** delta 复核时的 invoke 证据 */
  deltaInvokeId?: string | null;
  startedAt?: string | null;
  deltaAt?: string | null;
  passedAt?: string | null;
  /** 自动采集：完成检视交棒的 invoke（幂等键）与时间；不推断通过/需修改 */
  completedInvokeId?: string | null;
  completedAt?: string | null;
}

/** trace→work 绑定来源 */
export type WorkTraceBoundVia = "track_work" | "artifact_group" | "matter_origin" | "historical_trace";

/** 工作主档 */
export interface WorkItem {
  id: string;
  title: string;
  originKind: WorkOriginKind;
  originId: string | null;
  status: WorkStatus;
  conversationId: string | null;
  createdByOtterId: string | null;
  reviewRounds: WorkReviewRound[];
  evidenceQuality: WorkEvidenceQuality;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** trace→work 绑定行 */
export interface WorkItemTrace {
  workId: string;
  traceId: string;
  boundAt: string;
  boundVia: WorkTraceBoundVia;
}

/** conversation 的显式 resume 锚点 */
export interface ConversationActiveWork {
  conversationId: string;
  workId: string;
  anchoredEntryId: string | null;
  updatedAt: string;
}
