/**
 * MemoryRepository：记忆仓库 port（完整接口，向后兼容）。
 *
 * E 三分后，消费者应优先使用 MemoryReader / MemoryWriter / MemoryQueue 窄接口。
 * 本文件保留完整接口用于：
 * - verifyEmbeddingVersion 等需要跨读写的 bootstrap 场景
 * - 向后兼容（现有 import 不会立即断裂）
 * - SqliteMemoryRepository implements 声明
 */

import type {
  MemoryEntry,
  MemoryWeight,
  MemoryLayer,
  MemoryContentType,
} from "@entities/memory/memory-entry";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import type { EmbedModelMeta } from "./embedding-gateway";
import type { SearchFilters, FTSHit, SnippetHit, VecHit, DarkEntry } from "./memory-types";

// 共享类型从 memory-types.ts re-export（消除 memory-reader.ts 反向依赖）
export type {
  SearchFilters,
  RetrievalSource,
  FTSHit,
  SnippetHit,
  VecHit,
  DarkEntry,
} from "./memory-types";

export interface MemoryRepository {
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
  // 查询
  getById(id: string): Promise<MemoryEntry | null>;
  /**
   * F20260812mrcq Part 3：按 source_id + 可选 contentType 主键直查。
   * 用于 anchor 短路——F/R 文档 ID 形如 "F20260812mrcq" 作为 source_id 索引。
   * contentType 优先级：F ID 优先 'feature'（summary），R ID 优先 'research'（summary）。
   */
  getBySourceId(sourceId: string, contentType?: MemoryContentType): Promise<MemoryEntry | null>;
  /**
   * F20260812mrcq Part 2：按 source + chunk_index 查邻域（±1）。
   * 用于 context-expand——命中 chunk 后扩展前后 chunk。
   * 返回 0-2 个条目（chunk 0 向前无 / last 向后无）。
   */
  findNeighborsByChunkIndex(
    sourceTable: string,
    sourceId: string,
    chunkIndex: number,
  ): Promise<MemoryEntry[]>;
  /**
   * F20260812mrcq Part 2：按 conversation + createdAt 查前后各一条 message。
   * 用于 context-expand——命中 message 后扩展上下文消息。
   * 返回 0-2 个条目（首条向前无 / 末条向后无）。
   */
  findNeighborsByTime(
    conversationId: string,
    createdAt: string,
  ): Promise<MemoryEntry[]>;
  getEmbedding(memoryEntryId: string): Promise<Float32Array | null>;
  getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]>;
  // 检索
  searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]>;
  /** FTS5 检索 + highlight() 生成 snippet（渐进式披露） */
  searchFTSWithHighlight(query: string, filters: SearchFilters): Promise<SnippetHit[]>;
  searchVec(
    embedding: Float32Array,
    limit: number,
    filters: SearchFilters,
  ): Promise<VecHit[]>;
  hasVecTable(): boolean;
  /** F20260812mrcq Part 0：vec 路径当前是否运行时启用（受 disableVec 影响，区别于 hasVecTable） */
  isVecEnabled(): boolean;
  /** 按 ID 批量获取记忆条目（渐进式披露 get_memory_detail） */
  getDetails(ids: string[]): Promise<MemoryEntry[]>;
  // 更新
  incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void>;
  flagMemory(memoryEntryId: string, flagged: boolean): Promise<void>;
  updateLayerByConversation(conversationId: string, from: MemoryLayer, to: MemoryLayer): Promise<void>;
  /** F20260811mrpy Part 3：读取存储的 embedding 元信息 */
  getEmbeddingMeta(): Promise<Partial<EmbedModelMeta>>;
  /** F20260811mrpy Part 3：写入/更新 embedding 元信息 */
  setEmbeddingMeta(meta: EmbedModelMeta): Promise<void>;
  /**
   * F20260811mrpy Part 1 + F20260812mrcq Part 0/1：扫描无 vec 索引的暗化条目。
   */
  scanDarkEntries(includeDead?: boolean): Promise<{ entries: DarkEntry[]; total: number; vecDisabled: boolean }>;
  /**
   * F20260811mrpy Part 1：批量查询 entry 是否有 vec 索引（vecCoverage 计算用）。
   */
  hasEmbeddings(entryIds: string[]): Promise<Map<string, boolean>>;
  /**
   * F20260812mrcq Part 1：embedding 失败入队重试。
   */
  enqueueRetry(entryId: string, error: unknown): Promise<void>;
  /**
   * F20260812mrcq Part 1：认领 pending 任务（原子 UPDATE + RETURNING）。
   */
  claimPendingTasks(limit: number): Promise<Array<{
    entryId: string;
    content: string;
    attempts: number;
    lastAttemptAt: string | null;
    createdAt: string;
  }>>;
  /** F20260812mrcq Part 1：task 成功，删除 task 行 */
  markTaskDone(entryId: string): Promise<void>;
  /**
   * F20260812mrcq Part 1：task 失败，更新 last_error。
   */
  markTaskAttemptFailed(entryId: string, error: unknown, maxAttempts: number): Promise<void>;

  // ---- F20260813mren: 记忆关系层 ----

  /**
   * F20260813mren Part 2: 按 conversationId 获取消息条目（provenance 读路径用）。
   */
  getEntriesByConversation(
    conversationId: string,
    opts?: { contentType?: MemoryContentType[]; limit?: number },
  ): Promise<MemoryEntry[]>;

  /**
   * 创建关系边。幂等：同 (from, to, type) 已存在则返回已存在 edge id。
   */
  createEdge(input: {
    fromEntryId: string;
    toEntryId: string;
    edgeType: EdgeType;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  }): Promise<string>;

  /**
   * F20260813mren D6: 从某 entry 出发 BFS 遍历关系图。
   */
  getEdgesByEntry(entryId: string, opts?: {
    edgeTypes?: EdgeType[];
    direction?: "out" | "in";
  }): Promise<Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }>>;

  /** 按 edge id 获取单条边（unlink_memory 用） */
  getEdgeById(edgeId: string): Promise<MemoryEdge | null>;

  /** 删除一条边（unlink_memory 纠错用） */
  deleteEdge(edgeId: string): Promise<void>;

  /**
   * 按 entry id 批量清理关联边（deleteBySource 等 delete 路径调）。
   */
  deleteEdgesByEntryIds(entryIds: string[]): Promise<void>;
}
