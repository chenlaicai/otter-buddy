/* eslint-disable max-lines -- F20260814qswp 去重+拆分后约 700 行：entry CRUD + FTS/vec 检索 + 权重 + 暗化扫描 */

import type Database from "better-sqlite3";
import type { MemoryEntry, MemoryWeight, MemoryLayer, MemoryContentType } from "@entities/memory/memory-entry";
import type { MemoryEdge, EdgeType } from "@entities/memory/memory-edge";
import type {
  FTSHit,
  SearchFilters,
  VecHit,
  DarkEntry,
} from "@usecases/memory/memory-types";
import type { MemoryRepository } from "@usecases/memory/memory-repository";
import type { MemoryReader } from "@usecases/memory/memory-reader";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import type { MemoryQueue } from "@usecases/memory/memory-queue";
import type { EmbedModelMeta } from "@usecases/memory/embedding-gateway";
import {
  bufferToFloat32Array,
  rowToMemoryEntry,
  rowToMemoryWeight,
  type FtsHighlightRow,
  type MemoryEntryRow,
  type MemoryWeightRow,
  type VecRow,
} from "./memory-mapper";
import type { SnippetHit } from "@usecases/memory/memory-types";
import { tokenizeWithJieba, tokenizeQuery } from "@frameworks/db/jieba-tokenizer";
import {
  createEdge,
  getEdgesByEntry,
  getEdgeById,
  deleteEdge,
  deleteEdgesByEntryIds,
} from "./memory-edge-queries";
import {
  enqueueRetry,
  claimPendingTasks,
  markTaskDone,
  markTaskAttemptFailed,
} from "./embedding-task-queue";

import { escapeFtsQuery } from "../fts-utils";

const DEFAULT_FTS_LIMIT = 50;
const MAX_GET_DETAILS_BATCH = 100;

export class SqliteMemoryRepository implements MemoryRepository, MemoryReader, MemoryWriter, MemoryQueue {
  private readonly db: Database.Database;
  /**
   * F20260812mrcq Part 0：vec 表物理存在标志，构造时通过 checkVecTable 固化，readonly。
   * 不受 disableVec() 影响——区分"vec 表从未创建"vs"vec 表存在但运行时禁用"。
   * 用于 scanDarkEntries / hasEmbeddings / 各 DELETE vec 路径的守卫。
   */
  private readonly vecTableExists: boolean;
  /**
   * vec 路径运行时启用标志。构造时 = vecTableExists，可被 disableVec() 关闭。
   * 用于 storeEmbedding（写入）/ searchVec（查询）的运行时守卫。
   */
  private hasVec: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.vecTableExists = this.checkVecTable();
    this.hasVec = this.vecTableExists;
  }

  /** 检查 memory_vec 是否可用（表存在且可查询） */
  private checkVecTable(): boolean {
    try {
      this.db.prepare("SELECT 1 FROM memory_vec LIMIT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  /** F20260814qswp：统一事务包装（替代 8 处手写 BEGIN/COMMIT/ROLLBACK） */
  private runInTx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * F20260814qswp：单条 entry 的完整插入（entries + fts + fts_jieba + weights 四联）。
   * 此前在 storeEntry / replaceEntryBySource / replaceEntriesBySource 三处逐字重复，
   * schema 变更需同步改三处——统一为唯一写入路径。
   */
  private insertEntryRow(entry: MemoryEntry): void {
    this.db.prepare(`
      INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
        conversation_id, granularity, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.layer,
      entry.contentType,
      entry.sourceId,
      entry.sourceTable,
      entry.conversationId ?? null,
      entry.granularity,
      entry.content,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.createdAt,
    );
    // F20260805hybrid: jieba 分词，支持中文短查询
    this.db.prepare(`
      INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
    `).run(entry.id, tokenizeWithJieba(entry.content));
    this.db.prepare(`
      INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
      VALUES (?, 0, NULL, 0)
    `).run(entry.id);
  }

  /**
   * F20260814qswp：按 entry id 级联删除卫星数据（fts_jieba + vec? + weights +
   * embedding_tasks + edges，不含 memory_entries 本行——由调用方按 id 或按 source 删除）。
   * 此前在 deleteBySource / replaceEntryBySource / replaceEntriesBySource /
   * deleteBySourceAndType 四处逐字重复（历史上已被迫加过 3 次"联动清理"补丁）。
   * replaceEntryBySource 路径中边的重定向/删除已在调用前完成，此处 edges DELETE 为无害 no-op。
   */
  private cascadeDeleteSatellites(rowId: string): void {
    this.db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(rowId);
    // F20260803mval: memory_vec 是 vec0 虚拟表，sqlite-vec 扩展不可用时表不存在（D22 降级），删除前检查
    if (this.vecTableExists) {
      this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(rowId);
    }
    this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(rowId);
    // F20260812mrcq Part 1：联动清理 embedding_tasks（不依赖 FK CASCADE，与现有模式一致）
    this.db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?").run(rowId);
    // F20260813mren: 联动清理 memory_edges（同模式，不依赖 FK CASCADE）
    this.db.prepare("DELETE FROM memory_edges WHERE from_entry_id = ? OR to_entry_id = ?").run(rowId, rowId);
  }

  /**
   * F20260814qswp：jieba FTS 检索的共享 SQL（searchFTS 与 searchFTSWithHighlight
   * 此前的语句逐字相同，仅 SELECT 列消费方式不同——me.* 本就含 content，统一返回行）。
   */
  private searchFtsJiebaRows(query: string, filters: SearchFilters): FtsHighlightRow[] {
    // F20260805hybrid: 使用 jieba 分词表支持中文短查询
    const tokenizedQuery = tokenizeQuery(query);
    if (tokenizedQuery.length === 0) return [];

    const ct = this.buildContentTypeClause(filters);
    const ftsQuery = tokenizedQuery.map((t: string) => escapeFtsQuery(t)).join(" OR ");

    return this.db.prepare(`
      SELECT me.*, fts.rank AS bm25_score
      FROM memory_fts_jieba fts
      JOIN memory_entries me ON fts.memory_entry_id = me.id
      WHERE memory_fts_jieba MATCH ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
        AND (? IS NULL OR me.created_at >= ?)
        ${ct.clause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(
      ftsQuery,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
      filters.createdAfter ?? null, filters.createdAfter ?? null,
      ...ct.params,
      DEFAULT_FTS_LIMIT,
    ) as FtsHighlightRow[];
  }

  /** vec 表物理存在（不受 disableVec 影响） */
  hasVecTable(): boolean {
    return this.vecTableExists;
  }

  /** F20260812mrcq Part 0：vec 路径当前是否运行时启用 */
  isVecEnabled(): boolean {
    return this.hasVec;
  }

  /**
   * F20260811mrpy Part 3 + F20260812mrcq Part 0：
   * bootstrap 校验 embedding 版本不一致时调用，禁用 vec 路径。
   * - hasVec=false：searchVec / storeEmbedding 跳过，召回降级为纯 FTS
   * - 同步清空 memory_vec 表（vecTableExists 守卫），消除旧向量沉睡导致的混跑风险
   * - DELETE 包 try-catch：bootstrap 降级路径绝对不能因清表失败阻塞启动
   */
  disableVec(): void {
    this.hasVec = false;
    if (this.vecTableExists) {
      try {
        this.db.exec("DELETE FROM memory_vec");
      } catch (err) {
        // 清表失败不阻塞降级流程；下次 disableVec 或重启时再尝试
        // eslint-disable-next-line no-console -- repo 层无 logger 注入，console.warn 兜底
        console.warn(`[SqliteMemoryRepository] Failed to clear memory_vec during disableVec: ${err}`);
      }
    }
  }

  async storeEntry(entry: MemoryEntry): Promise<void> {
    this.runInTx(() => {
      this.insertEntryRow(entry);
    });
  }

  /** F20260803mval: 按 source 删除记忆条目（entries + fts + vec + weights 联动删除） */
  async deleteBySource(sourceTable: string, sourceId: string): Promise<void> {
    this.runInTx(() => {
      const rows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ?")
        .all(sourceTable, sourceId) as Array<{ id: string }>;
      for (const row of rows) {
        this.cascadeDeleteSatellites(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ?"
      ).run(sourceTable, sourceId);
    });
  }

  /** F20260803mval: 按 source 原子替换（单事务删旧+插新），B2 修复 */
  /** F20260803fbit: DELETE/SELECT WHERE 加 content_type 过滤，防 summary entry 和 body entry 互相删除 */
  /** F20260813mren 审视二轮 P1-12：1:1 summary entry 的边做重定向（旧 id→新 id），不再静默删边。
   *  顺序：插新行 → 重定向边 → 按旧 id 删旧行（不能用 source 删，会误删新行）。
   *  chunk 的 N:M replaceEntriesBySource 无法重定向，维持禁边（D3）。 */
  async replaceEntryBySource(entry: MemoryEntry): Promise<void> {
    this.runInTx(() => {
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(entry.sourceTable, entry.sourceId, entry.contentType) as Array<{ id: string }>;

      // 1. 插新（必须在重定向前——FK 要求新行先存在）
      this.insertEntryRow(entry);

      // 2. 边重定向：旧 id → 新 id（新 id 是全新 UUID，UNIQUE 不可能冲突）
      // 审视三轮 #2：多旧行（历史脏数据）只重定向第一行的边，其余旧行的边删除——
      // 否则两行同型边指向同一对端时 UPDATE 撞 UNIQUE 约束，整个 sync 永久失败（行为退化）。
      oldRows.forEach((row, index) => {
        if (index === 0) {
          this.db.prepare("UPDATE memory_edges SET from_entry_id = ? WHERE from_entry_id = ?").run(entry.id, row.id);
          this.db.prepare("UPDATE memory_edges SET to_entry_id = ? WHERE to_entry_id = ?").run(entry.id, row.id);
        } else {
          this.db.prepare("DELETE FROM memory_edges WHERE from_entry_id = ? OR to_entry_id = ?").run(row.id, row.id);
        }
      });

      // 3. 删旧行及联动数据（按 id 删；边的重定向/删除已在步骤 2 完成，级联中的 edges DELETE 为 no-op）
      for (const row of oldRows) {
        this.cascadeDeleteSatellites(row.id);
        this.db.prepare("DELETE FROM memory_entries WHERE id = ?").run(row.id);
      }
    });
  }

  /**
   * F20260803chunk: 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条）。
   * 用于 chunk 索引：文档 reindex 时删旧全部 chunk + 插新 N 个 chunk。
   * M1：所有 entries 必须同 (sourceTable, sourceId, contentType)，不一致抛异常。
   */
  async replaceEntriesBySource(entries: MemoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const { sourceTable, sourceId, contentType } = entries[0];
    // M1 校验：所有 entries 必须同 source
    for (const e of entries) {
      if (e.sourceTable !== sourceTable || e.sourceId !== sourceId || e.contentType !== contentType) {
        throw new Error(
          `replaceEntriesBySource requires homogeneous source, got mixed: ${e.sourceTable}/${e.sourceId}/${e.contentType}`,
        );
      }
    }

    this.runInTx(() => {
      // 删旧（同 source + 同 contentType 的全部 entry）
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(sourceTable, sourceId, contentType) as Array<{ id: string }>;
      for (const row of oldRows) {
        this.cascadeDeleteSatellites(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
      ).run(sourceTable, sourceId, contentType);

      // 插新（N 条 entry，每条独立 entryId）
      for (const entry of entries) {
        this.insertEntryRow(entry);
      }
    });
  }

  /**
   * PR审视 S3-14: 按 source + contentType 删除（body 清空时清理旧 chunk entries）。
   * 复用 replaceEntriesBySource 的 DELETE WHERE 模式（单事务删 entries+fts+vec+weights）。
   */
  async deleteBySourceAndType(sourceTable: string, sourceId: string, contentType: string): Promise<void> {
    this.runInTx(() => {
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(sourceTable, sourceId, contentType) as Array<{ id: string }>;
      for (const row of oldRows) {
        this.cascadeDeleteSatellites(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
      ).run(sourceTable, sourceId, contentType);
    });
  }

  async storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void> {
    // F20260803mval: vec 扩展不可用时 memory_vec 表不存在，跳过（与 deleteBySource/replaceEntryBySource 一致，S3）
    if (!this.hasVec) return;
    /** vec0 不支持 INSERT OR REPLACE，先删除再插入 */
    this.runInTx(() => {
      this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(memoryEntryId);
      this.db.prepare(`
        INSERT INTO memory_vec (memory_entry_id, embedding)
        VALUES (?, ?)
      `).run(memoryEntryId, embedding);
    });
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare(
      "SELECT * FROM memory_entries WHERE id = ?",
    ).get(id) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
  }

  /** #576（F20260901emps）：最近记忆（记忆搜索页初始态）——排除 chunk 分段碎片。
   *  不用 NOT LIKE '_chunk'（无 ESCAPE）：_ 在 LIKE 里是单字符通配，会误排除 xchunk 类 */
  async listRecent(limit: number): Promise<MemoryEntry[]> {
    const rows = this.db.prepare(
      `SELECT * FROM memory_entries
       WHERE content_type NOT IN ('feature_chunk', 'research_chunk', 'message_chunk')
       ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as MemoryEntryRow[];
    return rows.map(rowToMemoryEntry);
  }

  /**
   * F20260812mrcq Part 3：按 source_id + 可选 contentType 主键直查（anchor 短路用）。
   * 多条命中时取最新（created_at DESC）。
   */
  async getBySourceId(sourceId: string, contentType?: MemoryContentType): Promise<MemoryEntry | null> {
    const sql = contentType
      ? "SELECT * FROM memory_entries WHERE source_id = ? AND content_type = ? ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM memory_entries WHERE source_id = ? ORDER BY created_at DESC LIMIT 1";
    const row = (contentType
      ? this.db.prepare(sql).get(sourceId, contentType)
      : this.db.prepare(sql).get(sourceId)) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
  }

  /**
   * F20260812mrcq Part 2：按 source + chunk_index 查邻域（±1）。
   * chunk_index 存在 metadata JSON 中，用 json_extract 查询。
   * 性能：当前文档总量约 500 条，全表扫可接受（P0 简化方案，性能优化留 follow-up）。
   */
  async findNeighborsByChunkIndex(
    sourceTable: string,
    sourceId: string,
    chunkIndex: number,
  ): Promise<MemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE source_table = ?
        AND source_id = ?
        AND content_type IN ('feature_chunk', 'research_chunk')
        AND json_extract(metadata, '$.chunk_index') IN (?, ?)
      ORDER BY json_extract(metadata, '$.chunk_index') ASC
    `).all(sourceTable, sourceId, chunkIndex - 1, chunkIndex + 1) as MemoryEntryRow[];
    return rows.map(rowToMemoryEntry);
  }

  /**
   * F20260812mrcq Part 2：按 conversation + createdAt 查前后各一条 message。
   * 返回最多 2 条（前一条 + 后一条），按 createdAt ASC 排序。
   */
  async findNeighborsByTime(
    conversationId: string,
    createdAt: string,
  ): Promise<MemoryEntry[]> {
    const before = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE conversation_id = ?
        AND content_type = 'message'
        AND created_at < ?
      ORDER BY created_at DESC LIMIT 1
    `).get(conversationId, createdAt) as MemoryEntryRow | undefined;

    const after = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE conversation_id = ?
        AND content_type = 'message'
        AND created_at > ?
      ORDER BY created_at ASC LIMIT 1
    `).get(conversationId, createdAt) as MemoryEntryRow | undefined;

    const result: MemoryEntry[] = [];
    if (before) result.push(rowToMemoryEntry(before));
    if (after) result.push(rowToMemoryEntry(after));
    return result;
  }

  async getDetails(ids: string[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    if (ids.length > MAX_GET_DETAILS_BATCH) {
      throw new Error(`getDetails batch size ${ids.length} exceeds limit ${MAX_GET_DETAILS_BATCH}`);
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM memory_entries WHERE id IN (${placeholders})`,
    ).all(...ids) as MemoryEntryRow[];
    return rows.map(rowToMemoryEntry);
  }

  async getEmbedding(memoryEntryId: string): Promise<Float32Array | null> {
    const row = this.db.prepare(
      "SELECT embedding FROM memory_vec WHERE memory_entry_id = ?",
    ).get(memoryEntryId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return bufferToFloat32Array(row.embedding);
  }

  async getWeights(memoryEntryIds: string[]): Promise<MemoryWeight[]> {
    if (memoryEntryIds.length === 0) return [];
    const placeholders = memoryEntryIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM memory_weights WHERE memory_entry_id IN (${placeholders})`,
    ).all(...memoryEntryIds) as MemoryWeightRow[];
    return rows.map(rowToMemoryWeight);
  }

  async searchFTS(query: string, filters: SearchFilters): Promise<FTSHit[]> {
    const rows = this.searchFtsJiebaRows(query, filters);
    return rows.map(row => ({
      entryId: row.id,
      ftsRank: row.bm25_score,
      entry: rowToMemoryEntry(row),
    }));
  }

  async searchFTSWithHighlight(query: string, filters: SearchFilters): Promise<SnippetHit[]> {
    // F20260805hybrid: 搜索走 jieba 表，高亮走原始内容（避免分词碎片化）
    const tokenizedQuery = tokenizeQuery(query);
    if (tokenizedQuery.length === 0) return [];
    const rows = this.searchFtsJiebaRows(query, filters);

    // F20260811mrpy Part 2: 应用层 extractSnippet
    return rows.map(row => {
      const content = row.content || '';
      const snippet = this.extractSnippet(content, tokenizedQuery);
      return {
        entryId: row.id,
        ftsRank: row.bm25_score,
        entry: rowToMemoryEntry(row),
        snippet,
      };
    });
  }

  /**
   * F20260811mrpy Part 2: 应用层后处理高亮。
   * 拿 jieba 分词结果在 content 里 indexOf 定位匹配 token,截窗口（前后各 100 字符）。
   * 性能保护：tokens.slice(0, 10) 限制扫描 token 数防 O(n*m) 爆炸。
   * fallback：全部 token 未匹配上时,返回前 200 字符。
   */
  private extractSnippet(content: string, tokens: string[], windowSize = 100): string {
    if (!content) return '';
    let firstMatchPos = -1;
    for (const token of tokens.slice(0, 10)) {
      const idx = content.indexOf(token);
      if (idx >= 0) { firstMatchPos = idx; break; }
    }
    if (firstMatchPos < 0) {
      return content.slice(0, 200);
    }
    const start = Math.max(0, firstMatchPos - windowSize);
    const end = Math.min(content.length, firstMatchPos + windowSize);
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
  }

  async searchVec(
    embedding: Float32Array,
    limit: number,
    filters: SearchFilters,
  ): Promise<VecHit[]> {
    if (!this.hasVec) return [];

    const ct = this.buildContentTypeClause(filters);
    const rows = this.db.prepare(`
      SELECT mv.memory_entry_id, mv.distance, me.*
      FROM memory_vec mv
      JOIN memory_entries me ON mv.memory_entry_id = me.id
      WHERE mv.embedding MATCH ?
        AND k = ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
        AND (? IS NULL OR me.created_at >= ?)
        ${ct.clause}
      ORDER BY mv.distance
    `).all(
      embedding, limit,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
      filters.createdAfter ?? null, filters.createdAfter ?? null,
      ...ct.params,
    ) as VecRow[];

    return rows.map(row => ({
      entryId: row.id,
      distance: row.distance,
      entry: rowToMemoryEntry(row),
    }));
  }

  /** F20260803fbit: 构造 contentType IN (...) 过滤子句（数组多选） */
  private buildContentTypeClause(filters: SearchFilters): { clause: string; params: unknown[] } {
    if (!filters.contentType?.length) return { clause: "", params: [] };
    const placeholders = filters.contentType.map(() => "?").join(",");
    return { clause: `AND me.content_type IN (${placeholders})`, params: [...filters.contentType] };
  }

  async incrementRetrievalCounts(memoryEntryIds: string[]): Promise<void> {
    if (memoryEntryIds.length === 0) return;
    this.runInTx(() => {
      const stmt = this.db.prepare(`
        UPDATE memory_weights
        SET retrieval_count = retrieval_count + 1, last_retrieved_at = datetime('now')
        WHERE memory_entry_id = ?
      `);
      for (const id of memoryEntryIds) {
        stmt.run(id);
      }
    });
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    this.db.prepare(`
      UPDATE memory_weights SET user_flagged = ? WHERE memory_entry_id = ?
    `).run(flagged ? 1 : 0, memoryEntryId);
  }

  async updateLayerByConversation(
    conversationId: string,
    from: MemoryLayer,
    to: MemoryLayer,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE memory_entries SET layer = ?
      WHERE conversation_id = ? AND layer = ?
    `).run(to, conversationId, from);
  }

  /** F20260811mrpy Part 3：读取存储的 embedding 元信息（key-value 表） */
  async getEmbeddingMeta(): Promise<Partial<EmbedModelMeta>> {
    const rows = this.db.prepare(
      "SELECT key, value FROM embedding_meta",
    ).all() as Array<{ key: string; value: string }>;
    const meta: Partial<EmbedModelMeta> = {};
    for (const row of rows) {
      if (row.key === "model_id") meta.modelId = row.value;
      else if (row.key === "model_rev") meta.modelRev = row.value;
      else if (row.key === "dim") meta.dim = Number(row.value);
    }
    return meta;
  }

  /** F20260811mrpy Part 3：写入/更新 embedding 元信息（事务内全量覆盖） */
  async setEmbeddingMeta(meta: EmbedModelMeta): Promise<void> {
    const now = new Date().toISOString();
    this.runInTx(() => {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO embedding_meta (key, value, updated_at) VALUES (?, ?, ?)",
      );
      stmt.run("model_id", meta.modelId, now);
      stmt.run("model_rev", meta.modelRev, now);
      stmt.run("dim", String(meta.dim), now);
    });
  }

  /**
   * F20260811mrpy Part 1 + F20260812mrcq Part 0：扫描无 vec 索引的暗化条目。
   * 用 NOT EXISTS 子查询规避 vec0 虚拟表 anti-join 限制。
   *
   * F20260812mrcq Part 0 关键修复：用 vecTableExists 守卫（而非 hasVec），
   * 使 disableVec 后仍能检测全表暗化（之前因 hasVec=false 直接返回空，检测能力丧失）。
   *
   * 返回值语义：
   * - vecDisabled=true + entries=[]：vec 表从未创建（schema 失败）
   * - vecDisabled=true + entries=[全表]：disableVec 清表后的全表暗化（可恢复）
   * - vecDisabled=false + entries=[N]：部分暗化（日常累积）
   */
  async scanDarkEntries(includeDead: boolean = false): Promise<{ entries: DarkEntry[]; total: number; vecDisabled: boolean }> {
    if (!this.vecTableExists) {
      return { entries: [], total: 0, vecDisabled: true };
    }
    try {
      // F20260812mrcq Part 1：默认排除 status='dead' 的 dead-letter，防报告噪音
      const deadFilter = includeDead ? "" : `
        AND NOT EXISTS (
          SELECT 1 FROM embedding_tasks et
          WHERE et.entry_id = me.id AND et.status = 'dead'
        )
      `;
      const rows = this.db.prepare(`
        SELECT me.id, me.content_type, me.source_id, me.created_at
        FROM memory_entries me
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_vec mv WHERE mv.memory_entry_id = me.id
        )
        ${deadFilter}
        ORDER BY me.created_at DESC
        LIMIT 1000
      `).all() as Array<{ id: string; content_type: string; source_id: string; created_at: string }>;
      const entries: DarkEntry[] = rows.map(r => ({
        entryId: r.id,
        contentType: r.content_type,
        sourceId: r.source_id,
        createdAt: r.created_at,
      }));
      return { entries, total: entries.length, vecDisabled: !this.hasVec };
    } catch {
      return { entries: [], total: 0, vecDisabled: !this.hasVec };
    }
  }

  /**
   * F20260811mrpy Part 1 + F20260812mrcq Part 0：批量查询 entry 是否有 vec 索引。
   * 返回 Map<entryId, hasVec>。
   *
   * F20260812mrcq Part 0：用 vecTableExists 守卫——表存在但清空（disableVec 后）时
   * IN 查询返回空，Map 全 false，正确反映"这些 entry 当前没 vec"。
   */
  async hasEmbeddings(entryIds: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (entryIds.length === 0) return result;
    for (const id of entryIds) result.set(id, false);
    if (!this.vecTableExists) return result;
    try {
      const placeholders = entryIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT memory_entry_id FROM memory_vec WHERE memory_entry_id IN (${placeholders})`,
      ).all(...entryIds) as Array<{ memory_entry_id: string }>;
      for (const r of rows) result.set(r.memory_entry_id, true);
    } catch {
      // vec0 IN 查询异常：保守返回全 false
    }
    return result;
  }

  /** F20260812mrcq Part 1：embedding 失败入队重试（F20260814qswp 拆至 embedding-task-queue） */
  async enqueueRetry(entryId: string, error: unknown): Promise<void> {
    enqueueRetry(this.db, entryId, error);
  }

  /** F20260812mrcq Part 1：原子认领 pending 任务（F20260814qswp 拆至 embedding-task-queue） */
  async claimPendingTasks(
    limit: number,
  ): Promise<Array<{ entryId: string; content: string; attempts: number; lastAttemptAt: string | null; createdAt: string }>> {
    return claimPendingTasks(this.db, limit);
  }

  /** F20260812mrcq Part 1：task 成功，删除 task 行 */
  async markTaskDone(entryId: string): Promise<void> {
    markTaskDone(this.db, entryId);
  }

  /** F20260812mrcq Part 1：task 失败；attempts 耗尽转 dead */
  async markTaskAttemptFailed(entryId: string, error: unknown, maxAttempts: number): Promise<void> {
    markTaskAttemptFailed(this.db, entryId, error, maxAttempts);
  }

  // ---- F20260813mren: 记忆关系层 ----

  /** F20260813mren Part 2: 按 conversationId 获取消息条目（provenance 读路径） */
  async getEntriesByConversation(
    conversationId: string,
    opts?: { contentType?: MemoryContentType[]; limit?: number },
  ): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 50;
    const types = opts?.contentType;
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT * FROM memory_entries
        WHERE conversation_id = ? AND content_type IN (${placeholders})
        ORDER BY created_at ASC LIMIT ?
      `).all(conversationId, ...types, limit) as MemoryEntryRow[];
      return rows.map(rowToMemoryEntry);
    }
    const rows = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE conversation_id = ?
      ORDER BY created_at ASC LIMIT ?
    `).all(conversationId, limit) as MemoryEntryRow[];
    return rows.map(rowToMemoryEntry);
  }

  /** F20260813mren: 创建关系边（F20260814qswp 拆至 memory-edge-queries） */
  async createEdge(input: {
    fromEntryId: string;
    toEntryId: string;
    edgeType: EdgeType;
    metadata?: Record<string, unknown>;
    createdBy?: string;
  }): Promise<string> {
    return createEdge(this.db, input);
  }

  /** F20260813mren: 1 跳邻居查询（D4 方向语义见 memory-edge-queries） */
  async getEdgesByEntry(entryId: string, opts?: {
    edgeTypes?: EdgeType[];
    direction?: "out" | "in";
  }): Promise<Array<{ edge: MemoryEdge; neighborEntry: MemoryEntry }>> {
    return getEdgesByEntry(this.db, entryId, opts);
  }

  /** F20260813mren: 按 id 获取单条边 */
  async getEdgeById(edgeId: string): Promise<MemoryEdge | null> {
    return getEdgeById(this.db, edgeId);
  }

  /** F20260813mren: 删除一条边（unlink_memory 用） */
  async deleteEdge(edgeId: string): Promise<void> {
    deleteEdge(this.db, edgeId);
  }

  /** F20260813mren D7: 按 entry id 批量清理关联边（delete 路径联动） */
  async deleteEdgesByEntryIds(entryIds: string[]): Promise<void> {
    deleteEdgesByEntryIds(this.db, entryIds);
  }
}
