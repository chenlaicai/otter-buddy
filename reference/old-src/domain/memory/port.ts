/**
 * MemoryPort：domain/memory 唯一的公开接口。
 *
 * 方法行为参见 F20260713m5q3 设计文档。
 * refine/expand/addKeyInfo/linkResource 不在此接口（属 app/orchestration / app/agent-runtime）。
 */

import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryLayer,
  MemoryWeight,
  RetrievalResult,
  SearchQuery,
} from "./model";

export interface MemoryPort {
  // --- Memory Entry CRUD ---

  /** 存储记忆条目。同步写入 memory_entries + memory_fts + memory_weights，异步写入 memory_vec */
  store(entry: MemoryEntryInput): Promise<string>;

  /** 按 ID 查询记忆条目 */
  getById(id: string): Promise<MemoryEntry | null>;

  /** 按来源查询记忆条目 */
  getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null>;

  // --- 混合检索 ---

  /** 混合检索（FTS5 + vec0 + RRF + 权重重排） */
  search(query: SearchQuery): Promise<RetrievalResult>;

  /** 查找相似条目（getEmbedding -> searchVec -> 权重重排） */
  searchSimilar(id: string, limit: number): Promise<RetrievalResult>;

  // --- Layer 管理 ---

  /** 批量更新 layer（Session 归档时 working -> historical） */
  updateLayerByConversation(
    conversationId: string,
    fromLayer: MemoryLayer,
    toLayer: MemoryLayer,
  ): Promise<void>;

  // --- 权重管理 ---

  /** 获取记忆条目权重 */
  getWeight(memoryEntryId: string): Promise<MemoryWeight>;

  /** 递增检索计数 + 更新最后检索时间 */
  incrementRetrievalCount(memoryEntryId: string): Promise<void>;

  /** 用户标记/取消标记记忆 */
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;

  // --- Embedding ---

  /** 存储 embedding 向量到 memory_vec */
  storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void>;

  /** 获取 embedding 向量 */
  getEmbedding(memoryEntryId: string): Promise<Float32Array | null>;
}
