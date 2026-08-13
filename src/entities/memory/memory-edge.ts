/**
 * F20260813mrel: 记忆关系层实体。
 * memory_entries 之间的有向关系边，让 flat 数据变成可遍历的记忆图。
 */

/** 边类型（固定枚举，D2 决策：4 种） */
export type EdgeType = "produced" | "references" | "supersedes" | "relates-to";

/** F20260813mrel: 运行时校验字符串是否为合法 EdgeType */
const VALID_EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  "produced", "references", "supersedes", "relates-to",
]);
export function isEdgeType(s: string): s is EdgeType {
  return VALID_EDGE_TYPES.has(s as EdgeType);
}

/**
 * 边类型语义（D4: relates-to 查询层自动双向，其余单向）。
 * 用于 GetRelated 生成 SQL WHERE 条件。
 */
export function isSymmetricEdgeType(type: EdgeType): boolean {
  return type === "relates-to";
}

/** 记忆关系边实体 */
export interface MemoryEdge {
  id: string;
  fromEntryId: string;
  toEntryId: string;
  edgeType: EdgeType;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** 创建者（otter id 或 "user"），可选 */
  createdBy: string | null;
}

/**
 * F20260813mrel D6: GetRelated 返回的结构化路径项。
 * LLM 拿到后能理解 "A 指向 B，B 指向 C" 的链式关系，而非平铺列表。
 */
export interface RelatedEntryItem {
  /** 邻居 entry（含完整 MemoryEntry 字段） */
  entry: {
    id: string;
    layer: string;
    contentType: string;
    sourceId: string;
    sourceTable: string;
    conversationId: string | null;
    granularity: string;
    content: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };
  /** 这条边的类型 */
  edgeType: EdgeType;
  /** 边的起点 entry id（判断方向用：若 edgeFromEntryId == 起点，则是出边；否则入边） */
  edgeFromEntryId: string;
  /** BFS 深度（起点 depth=0，直接邻居 depth=1） */
  depth: number;
}
