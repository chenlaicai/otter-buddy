/**
 * MemoryWriter：记忆写入 port。
 *
 * 从 MemoryRepository 拆出（E 三分），职责：
 * - 存储记忆条目
 * - 存储 embedding
 * - 删除记忆条目
 * - 替换记忆条目
 * - 更新记忆权重
 * - 管理记忆关系边
 */

import type {
  MemoryEntry,
  MemoryContentType,
  MemoryLayer,
} from "@entities/memory/memory-entry";
import type { EdgeType } from "@entities/memory/memory-edge";
import type { EmbedModelMeta } from "./embedding-gateway";

export interface MemoryWriter {
  // 写入
  storeEntry(entry: MemoryEntry): Promise<void>;
  storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void>;
  /** F20260803mval: 按 source 删除记忆条目（upsert reindex 时清旧 entry，防 FTS 命中陈旧内容） */
  deleteBySource(sourceTable: string, sourceId: string): Promise<void>;
  /** F20260803mval: 按 source 原子替换（单事务内删旧+插新，防 upsert 中间失败丢数据，B2 修复） */
  replaceEntryBySource(entry: MemoryEntry): Promise<void>;
  /** F20260803chunk: 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条），chunk 索引用 */
  replaceEntriesBySource(entries: MemoryEntry[]): Promise<void>;
  /** PR审视 S3-14: 按 source + contentType 删除（body 清空时清理旧 chunk entries） */
  deleteBySourceAndType(sourceTable: string, sourceId: string, contentType: MemoryContentType): Promise<void>;
  // 更新
  incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void>;
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;
  updateLayerByConversation(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
  /** F20260811mrpy Part 3：写入/更新 embedding 元信息 */
  setEmbeddingMeta(meta: EmbedModelMeta): Promise<void>;

  // ---- F20260813mren: 记忆关系层 ----

  /**
   * 创建关系边。幂等：同 (from, to, type) 已存在则返回已存在 edge id。
   * 应用层保证 from/to 是 coarse 粒度 entry（防 chunk sync 丢边，见 CreateEdge use case）。
   */
  createEdge(input: {
    fromEntryId: string;
    toEntryId: string;
    edgeType: EdgeType;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  }): Promise<string>;

  /** 删除一条边（unlink_memory 纠错用） */
  deleteEdge(edgeId: string): Promise<void>;

  /**
   * 按 entry id 批量清理关联边（deleteBySource 等 delete 路径调）。
   * D7: 不依赖 FK CASCADE，手动 DELETE（与 embedding_tasks 模式一致）。
   */
  deleteEdgesByEntryIds(entryIds: string[]): Promise<void>;
}
