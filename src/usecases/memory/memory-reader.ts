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
import type { BeliefStatus } from "@entities/memory/belief";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import type { EmbedModelMeta } from "./embedding-gateway";
import type {
  SearchFilters,
  FTSHit,
  SnippetHit,
  VecHit,
  DarkEntry,
} from "./memory-types";

export interface MemoryReader {
  // 查询
  getById(id: string): Promise<MemoryEntry | null>;
  /**
   * 按 source_id + 可选 contentType 主键直查。
   * 用于 anchor 短路——F/R 文档 ID 形如 "" 作为 source_id 索引。
   * contentType 优先级：F ID 优先 'feature'（summary），R ID 优先 'research'（summary）。
   */
  getBySourceId(sourceId: string, contentType?: MemoryContentType): Promise<MemoryEntry | null>;
  /**
   * 按 source + chunk_index 查邻域（±1）。
   * 用于 context-expand——命中 chunk 后扩展前后 chunk。
   * 返回 0-2 个条目（chunk 0 向前无 / last 向后无）。
   */
  findNeighborsByChunkIndex(
    sourceTable: string,
    sourceId: string,
    chunkIndex: number,
  ): Promise<MemoryEntry[]>;
  /**
   * 按 conversation + createdAt 查前后各一条 message。
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
  /** vec 路径当前是否运行时启用（受 disableVec 影响，区别于 hasVecTable） */
  isVecEnabled(): boolean;
  /** 按 ID 批量获取记忆条目（渐进式披露 get_memory_detail） */
  getDetails(ids: string[]): Promise<MemoryEntry[]>;
  /** 读取存储的 embedding 元信息 */
  getEmbeddingMeta(): Promise<Partial<EmbedModelMeta>>;
  /**
   * + /1：扫描无 vec 索引的暗化条目。
   *
   * 用 vecTableExists 守卫，disableVec 后仍可检测全表暗化。
   * 默认排除 status='dead' 的 dead-letter（防报告噪音）。
   *   传 includeDead=true 可查看全部（运维排查）。
   */
  scanDarkEntries(includeDead?: boolean): Promise<{ entries: DarkEntry[]; total: number; vecDisabled: boolean }>;
  /**
   * 批量查询 entry 是否有 vec 索引（vecCoverage 计算用）。
   * 返回 Map<entryId, hasVec>。vec 表不可用时所有 entry 返回 false。
   */
  hasEmbeddings(entryIds: string[]): Promise<Map<string, boolean>>;
  /**
   * 按 conversationId 获取消息条目（provenance 读路径用）。
   * 不做预筛选，返回全部（按 limit 截断），附带 role/turn 等元数据。
   */
  getEntriesByConversation(
    conversationId: string,
    opts?: { contentType?: MemoryContentType[]; limit?: number },
  ): Promise<MemoryEntry[]>;

  /**
   * 从某 entry 出发 BFS 遍历关系图。
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

  /**
   * 批量查候选条目里哪些被 supersede。
   * 返回 Map<旧条目 ID, 取代它的条目 ID>（supersedes 边的 from→to）。
   * 用于检索端 stale 降权 + 标注「已被 [新条目] 取代」。
   */
  getSupersededBy(entryIds: string[]): Promise<Map<string, string>>;

  /**
   * 按生命周期状态 + 创建时间区间列出 belief 条目（夜间审视清单数据源）。
   * 区间为闭区间 [after, through]，createdAt 升序（按现场时间先后审视）。
   * status 用 json_extract(metadata, '$.status') 匹配。
   */
  listBeliefsByStatus(
    status: BeliefStatus,
    after: string,
    through: string,
  ): Promise<MemoryEntry[]>;
}
