import type {
  MemoryContentType,
  MemoryEntry,
  MemoryWeight,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { SnippetHit } from "@usecases/memory/memory-repository";

export interface MemoryEntryRow {
  id: string;
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
