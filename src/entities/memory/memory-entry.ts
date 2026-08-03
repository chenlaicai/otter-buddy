/** 记忆层 */
export type MemoryLayer = "working" | "historical" | "document";

/**
 * 记忆层转换是否有效。
 * working ↔ historical 双向。
 * document 层不需要状态转换（文档生命周期由 status 字段管理）。
 */
export function canTransitionMemoryLayer(from: MemoryLayer, to: MemoryLayer): boolean {
  // document 层不需要状态转换
  if (from === "document" || to === "document") return false;
  if (from === to) return false;
  if (from === "working" && to === "historical") return true;
  if (from === "historical" && to === "working") return true;
  return false;
}

/** 记忆内容类型 */
export type MemoryContentType =
  | "message"
  | "fact"
  | "linked_resource"
  | "feature"
  | "feature_body"
  | "research"
  | "research_body";

/** F20260803fbit: 运行时校验字符串是否为合法 MemoryContentType（HTTP 参数校验等） */
const VALID_CONTENT_TYPES: ReadonlySet<string> = new Set<MemoryContentType>([
  "message", "fact", "linked_resource", "feature", "feature_body", "research", "research_body",
]);
export function isMemoryContentType(s: string): s is MemoryContentType {
  return VALID_CONTENT_TYPES.has(s);
}

/** Feature 记忆条目的 metadata */
export interface FeatureMemoryMetadata {
  doc_type: "feature";
  change_type: "feature" | "refactor" | "fix";
  tags: string[];
  modules: string[];
  from: string[];
  supersedes?: string[];
}

/** Research 记忆条目的 metadata */
export interface ResearchMemoryMetadata {
  doc_type: "research";
  exploration_type: "technical" | "market" | "user-research";
  tags: string[];
  conclusion?: string;
  from: string[];
  supersedes?: string[];
}

/** 检索粒度 */
export type RetrievalGranularity = "coarse" | "fine";

/** 渐进式披露 detail_level */
export type DetailLevel = "summary" | "snippet" | "full";

/** 记忆条目实体 */
export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId: string | null;
  granularity: RetrievalGranularity;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** 记忆权重实体 */
export interface MemoryWeight {
  memoryEntryId: string;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  userFlagged: boolean;
}
