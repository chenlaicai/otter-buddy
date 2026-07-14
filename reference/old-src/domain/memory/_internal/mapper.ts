/**
 * 领域对象 <-> DB 行映射。
 *
 * 映射规则参见 F20260713m5q3 设计文档。
 */

import type {
  MemoryContentType,
  MemoryEntry,
  MemoryLayer,
  MemoryWeight,
  RetrievalGranularity,
} from "../model";

/** DB 行类型（better-sqlite3 返回） */
export interface MemoryEntryRow {
  id: string;
  layer: string;
  content_type: string;
  source_id: string;
  source_table: string;
  conversation_id: string | null;
  tree_path: string | null;
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

/** FTS5 查询结果行（memory_entries 列 + bm25_score） */
export interface FtsRow extends MemoryEntryRow {
  bm25_score: number;
}

/** vec0 查询结果行（memory_entry_id + distance + memory_entries 列） */
export interface VecRow extends MemoryEntryRow {
  distance: number;
}

export function rowToMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    layer: row.layer as MemoryLayer,
    contentType: row.content_type as MemoryContentType,
    sourceId: row.source_id,
    sourceTable: row.source_table,
    conversationId: row.conversation_id,
    treePath: row.tree_path,
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

/** 将 Buffer（sqlite-vec 返回）转换为 Float32Array */
export function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}
