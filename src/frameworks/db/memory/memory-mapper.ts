import type {
  MemoryLayer,
  MemoryContentType,
  MemoryEntry,
  MemoryWeight,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import type { SnippetHit } from "@usecases/memory/memory-repository";

export interface MemoryEntryRow {
  id: string;
  layer: string;
  content_type: string;
  source_id: string;
  source_table: string;
  conversation_id: string | null;
  granularity: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface MemoryWeightRow {
  memory_entry_id: string;
  retrieval_count: number;
  last_retrieved_at: string | null;
  user_flagged: number;
}

export interface FtsRow extends MemoryEntryRow {
  bm25_score: number;
}

export interface VecRow extends MemoryEntryRow {
  distance: number;
}

/** FTS5 highlight() 查询返回的行类型 */
export interface FtsHighlightRow extends MemoryEntryRow {
  bm25_score: number;
  snippet: string;
}

export function rowToMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    layer: row.layer as MemoryLayer,
    contentType: row.content_type as MemoryContentType,
    sourceId: row.source_id,
    sourceTable: row.source_table,
    conversationId: row.conversation_id,
    granularity: row.granularity as RetrievalGranularity,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

export function rowToMemoryWeight(row: MemoryWeightRow): MemoryWeight {
  return {
    memoryEntryId: row.memory_entry_id,
    retrievalCount: row.retrieval_count,
    lastRetrievedAt: row.last_retrieved_at,
    userFlagged: row.user_flagged === 1,
  };
}

/** 将 FTS5 highlight() 行映射为 SnippetHit */
export function rowToSnippetHit(row: FtsHighlightRow): SnippetHit {
  return {
    entryId: row.id,
    ftsRank: row.bm25_score,
    entry: rowToMemoryEntry(row),
    snippet: row.snippet,
  };
}

/** 将 Buffer（sqlite-vec 返回）转换为 Float32Array */
export function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

// ---- F20260813mren: 记忆关系层 mappers ----

/** memory_edges 表行（SELECT * 时 snake_case 列名） */
export interface MemoryEdgeRow {
  id: string;
  from_entry_id: string;
  to_entry_id: string;
  edge_type: string;
  metadata: string | null;
  created_at: string;
  created_by: string | null;
}

/** 将 memory_edges 行映射为 MemoryEdge 实体 */
export function rowToMemoryEdge(row: MemoryEdgeRow | Record<string, unknown>): MemoryEdge {
  const r = row as MemoryEdgeRow;
  return {
    id: r.id,
    fromEntryId: r.from_entry_id,
    toEntryId: r.to_entry_id,
    edgeType: r.edge_type as EdgeType,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

/**
 * 将 JOIN 查询返回的带前缀列（m_id, m_layer 等）映射为 MemoryEntry。
 * getEdgesByEntry 用 `JOIN memory_entries m` + 列别名 `m_*`。
 */
export function rowToMemoryEntryJoined(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.m_id as string,
    layer: row.m_layer as MemoryLayer,
    contentType: row.m_content_type as MemoryContentType,
    sourceId: row.m_source_id as string,
    sourceTable: row.m_source_table as string,
    conversationId: row.m_conversation_id as string | null,
    granularity: row.m_granularity as RetrievalGranularity,
    content: row.m_content as string,
    metadata: row.m_metadata ? (JSON.parse(row.m_metadata as string) as Record<string, unknown>) : null,
    createdAt: row.m_created_at as string,
  };
}
