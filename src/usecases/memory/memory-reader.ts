/**
 * MemoryReader：记忆检索 port。
 *
 * 从 MemoryRepository 拆出（E 三分），职责：
 * - 查询记忆条目
 * - 检索记忆（FTS/vec）
 * - 获取记忆权重
 * - 获取记忆详情
 */

import type {
  MemoryEntry,
  MemoryWeight,
  MemoryContentType,
} from "@entities/memory/memory-entry";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import type { EmbedModelMeta } from "./embedding-gateway";
import type {
  SearchFilters,
  FTSHit,
  SnippetHit,
  VecHit,
  DarkEntry,
} from "./memory-repository";

export interface MemoryReader {
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
  /** F20260811mrpy Part 3：读取存储的 embedding 元信息 */
  getEmbeddingMeta(): Promise<Partial<EmbedModelMeta>>;
  /**
   * F20260811mrpy Part 1 + F20260812mrcq Part 0/1：扫描无 vec 索引的暗化条目。
   *
   * F20260812mrcq Part 0：用 vecTableExists 守卫，disableVec 后仍可检测全表暗化。
   * F20260812mrcq Part 1：默认排除 status='dead' 的 dead-letter（防报告噪音）。
   *   传 includeDead=true 可查看全部（运维排查）。
   */
  scanDarkEntries(includeDead?: boolean): Promise<{ entries: DarkEntry[]; total: number; vecDisabled: boolean }>;
  /**
   * F20260811mrpy Part 1：批量查询 entry 是否有 vec 索引（vecCoverage 计算用）。
   * 返回 Map<entryId, hasVec>。vec 表不可用时所有 entry 返回 false。
   */
  hasEmbeddings(entryIds: string[]): Promise<Map<string, boolean>>;
  /**
   * F20260813mren Part 2: 按 conversationId 获取消息条目（provenance 读路径用）。
   * D8: 不做预筛选，返回全部（按 limit 截断），附带 role/turn 等元数据。
   */
  getEntriesByConversation(
    conversationId: string,
    opts?: { contentType?: MemoryContentType[]; limit?: number },
  ): Promise<MemoryEntry[]>;

  /**
   * F20260813mren D6: 从某 entry 出发 BFS 遍历关系图。
   * 返回 [{ edge, entry }]——边 + 邻居 entry 配对，让调用方拼结构化 path。
   * depth 默认 1。visited 守门防环。
   * relates-to 自动双向查（from OR to），其余单向。
   */
  getEdgesByEntry(entryId: string, opts?: {
    edgeTypes?: EdgeType[];
    direction?: "out" | "in";
  }): Promise<Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }>>;

  /** 按 edge id 获取单条边（unlink_memory 用） */
  getEdgeById(edgeId: string): Promise<MemoryEdge | null>;
}
