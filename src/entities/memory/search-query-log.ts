/**
 * 检索埋点实体。
 *
 * 记录 search_memory 真实调用（查询 + 命中 + 对话上下文），
 * 供评估基线标注使用（无日志基建则 无法启动）。
 * 上下文消息快照是标注者还原查询意图的依据（防"测标注者记忆"的选择偏差）。
 */

/**
 * 埋点记录模式（隐私默认边界）：
 * - metadata-only（默认）：只写 queryHash/queryLength 与检索元数据——不写 query 原文，
 *   不读取/写入对话上下文预览；legacy query/context_messages 列落空值，不伪造脱敏正文
 * - redacted（显式评估用途）：query/preview 先过 secrets 脱敏再落库；external 对话不记正文
 *   （query 落空、preview 不读）；必须搭配有限保留期
 * - off：零写入零读取
 */
export type SearchQueryLogMode = "metadata-only" | "redacted" | "off";

/** 写入参数（repo 层生成 id / created_at） */
export interface SearchQueryLogInsert {
  /** 原文仅在 redacted 模式（脱敏后）落库；metadata-only 落空串 */
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
  /** 查询原文 sha256（metadata-only 模式下对齐/去重的唯一指纹） */
  queryHash: string;
  /** 查询原文长度（metadata-only 模式下唯一体积信号） */
  queryLength: number;
  /** 本行落库模式（redacted 行受保留期约束） */
  logMode: Exclude<SearchQueryLogMode, "off">;
  /** 上下文快照仅 redacted 模式构建（脱敏后）；metadata-only 落 [] */
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
