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
  /** F20260803mval: 按 source 原子替换（单事务内删旧+插新，防 upsert 中间失败丢数据，B2 修复）。
   *  F20261110dsqci（#1818 检视鬾5）：返回 embeddingKept——同 id 快路径下旧 content 与新 content
   *  一致且 vec 行存在时，vec 不删除（embedding 无需重算，调用方据此跳过 fireAndForgetEmbed）。
   *  动机：归档-复活振荡恢复轮 ~1100 篇 summary 若全部重 embed 会挤占 live 通道。 */
  replaceEntryBySource(entry: MemoryEntry): Promise<{ embeddingKept: boolean }>;
  /** F20260803chunk: 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条），chunk 索引用。
   *  F20261110dsqci（#1818）：opts.reuseEntryIds——内容未变复用旧 entry id 的集合：
   *  这些 entry 不删不重建（向量/fts/weights 全保留），仅 UPDATE metadata（chunk_index
   *  等环境字段漂移随新值落库）。
   *  返回 reusedEntryIds = 实际生效的复用集（事务内核实与现存行交集）：
   *  规划复用但行已不存在（并发 reindex 中被另一次 sync 删掉）的 stale id 会降级为
   *  INSERT 该 entry（entries 携带完整数据）——调用方必须以返回值为准决定是否登记
   *  embedding 任务（stale 降级 = 新建，需要重算）。并发正确性关键（检视鬾1：
   *  拿 stale 规划跳过登记会把文档 chunk 删成 0 且无法恢复）。 */
  replaceEntriesBySource(entries: MemoryEntry[], opts?: { reuseEntryIds?: ReadonlySet<string> }): Promise<{ reusedEntryIds: Set<string> }>;
  /** F20261110dsqci（#1818）：读同 source+contentType 的现存 entries——chunk 复用对齐用
   *  （sync reindex 前比对旧 chunk，内容未变的复用，消除向量白算）。 */
  findEntriesBySourceAndType(sourceTable: string, sourceId: string, contentType: MemoryContentType): Promise<MemoryEntry[]>;
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
