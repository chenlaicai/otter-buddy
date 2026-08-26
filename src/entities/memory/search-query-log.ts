/**
 * F20260826rcmm Phase 0：检索埋点实体。
 *
 * 记录 search_memory 真实调用（查询 + 命中 + 对话上下文），
 * 供评估基线标注使用（R20260826rcmm：无日志基建则 Phase 0 无法启动）。
 * 上下文消息快照是标注者还原查询意图的依据（防"测标注者记忆"的选择偏差）。
 */

/** 写入参数（repo 层生成 id / created_at） */
export interface SearchQueryLogInsert {
  query: string;
  conversationId: string;
  /** 发起检索的 Otter ID（agent 工具路径注入；HTTP 路径为 null） */
  callerId: string | null;
  detailLevel?: string;
  library?: string;
  limitCount?: number;
  /** top-N 命中条目 ID（JSON 数组存 TEXT）。N=5：标注时核对前 5 名是否含理想条目 */
  topEntryIds: string[];
  total: number;
  /** 查询发起时的对话上下文快照（最近 5 条，JSON 存 TEXT） */
  contextMessages: SearchQueryContextMessage[];
}

/** 上下文消息快照（截断预览，不存全文） */
export interface SearchQueryContextMessage {
  id: string;
  senderId: string;
  role: string;
  /** 正文前 160 字符（意图还原够用即可，控制体积） */
  preview: string;
}

/** 完整实体（读回用） */
export interface SearchQueryLog extends SearchQueryLogInsert {
  id: string;
  createdAt: string;
}
