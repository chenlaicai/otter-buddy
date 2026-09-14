/**
 * 活动页 API 契约（F20260912avlb）：三域台账只读 DTO。
 *
 * 三域：healing（自愈事件）/ signals（獭间信号）/ dispatch（派工台账）。
 * 全只读——无任何写端点（搭档拍板：纯展示认知对齐，处置走对话内）。
 * 中文标签映射在前端（health 页 SIGNAL_TYPE_LABELS 同模式）。
 */

/** ── healing 域 ── */

export interface HealingEventDTO {
  id: string;
  conversationId: string;
  otterId: string;
  errorType: string;
  severity: string;
  description: string;
  suggestion: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface HealingEventsResponseDTO {
  events: HealingEventDTO[];
  count: number;
}

/** ── signals 域（獭间结构化信号） ── */

export interface SignalEventDTO {
  id: string;
  conversationId: string;
  messageId: string;
  fromOtterId: string;
  targetOtterId: string | null;
  type: string;
  severity: string;
  /** 信号正文（halt=停手理由；objection=事实依据；blocked=卡点+已试清单） */
  payload: string;
  status: string;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SignalEventsResponseDTO {
  signals: SignalEventDTO[];
  count: number;
}

/** ── dispatch 域（派工台账） ── */

export interface DispatchRecordDTO {
  id: string;
  conversationId: string;
  otterId: string;
  otterName: string;
  task: string;
  /** 客观生命周期：created=就位待命 / dispatched=已派工 / dissolved=獭已解散 */
  status: string;
  createdAt: string;
  dispatchedAt: string | null;
  dissolvedAt: string | null;
  /** 该獭当前是否在场（实时 join 参与者表，不落库） */
  present: boolean;
}

export interface DispatchRecordsResponseDTO {
  records: DispatchRecordDTO[];
  count: number;
}
