/* eslint-disable max-lines -- F20260811mrpy 加入 embedding_meta/dark-entries/hasEmbeddings 后续接近 600 行 */

import type Database from "better-sqlite3";
import type { MemoryEntry, MemoryWeight, MemoryLayer, MemoryContentType } from "@entities/memory/memory-entry";
import type {
  FTSHit,
  MemoryRepository,
  SearchFilters,
  VecHit,
  DarkEntry,
} from "@usecases/memory/memory-repository";
import type { EmbedModelMeta } from "@usecases/memory/embedding-gateway";
import {
  bufferToFloat32Array,
  rowToMemoryEntry,
  rowToMemoryWeight,
  type FtsRow,
  type FtsHighlightRow,
  type MemoryEntryRow,
  type MemoryWeightRow,
  type VecRow,
} from "./memory-mapper";
import type { SnippetHit } from "@usecases/memory/memory-repository";
import { tokenizeWithJieba, tokenizeQuery } from "@frameworks/db/jieba-tokenizer";

import { escapeFtsQuery } from "../fts-utils";

const DEFAULT_FTS_LIMIT = 50;
const MAX_GET_DETAILS_BATCH = 100;

export class SqliteMemoryRepository implements MemoryRepository {
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
    this.db.exec("BEGIN");
    try {
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

      this.db.prepare(`
        INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)
      `).run(entry.id, entry.content);

      // F20260805hybrid: jieba 分词，支持中文短查询
      const tokenizedContent = tokenizeWithJieba(entry.content);
      this.db.prepare(`
        INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
      `).run(entry.id, tokenizedContent);

      this.db.prepare(`
        INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
        VALUES (?, 0, NULL, 0)
      `).run(entry.id);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** F20260803mval: 按 source 删除记忆条目（entries + fts + vec + weights 联动删除） */
  async deleteBySource(sourceTable: string, sourceId: string): Promise<void> {
    this.db.exec("BEGIN");
    try {
      const rows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ?")
        .all(sourceTable, sourceId) as Array<{ id: string }>;
      for (const row of rows) {
        this.db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        this.db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(row.id);
        // F20260803mval: memory_vec 是 vec0 虚拟表，sqlite-vec 扩展不可用时表不存在（D22 降级），删除前检查
        if (this.vecTableExists) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
        // F20260812mrcq Part 1：联动清理 embedding_tasks（不依赖 FK CASCADE，与现有模式一致）
        this.db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?").run(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ?"
      ).run(sourceTable, sourceId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** F20260803mval: 按 source 原子替换（单事务删旧+插新），B2 修复 */
  /** F20260803fbit: DELETE/SELECT WHERE 加 content_type 过滤，防 summary entry 和 body entry 互相删除 */
  async replaceEntryBySource(entry: MemoryEntry): Promise<void> {
    this.db.exec("BEGIN");
    try {
      // 删旧（同 source + 同 contentType），复用 deleteBySource 的联动删除逻辑
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(entry.sourceTable, entry.sourceId, entry.contentType) as Array<{ id: string }>;
      for (const row of oldRows) {
        this.db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        this.db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(row.id);
        if (this.vecTableExists) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
        // F20260812mrcq Part 1：联动清理 embedding_tasks（不依赖 FK CASCADE，与现有模式一致）
        this.db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?").run(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
      ).run(entry.sourceTable, entry.sourceId, entry.contentType);

      // 插新（同 storeEntry 逻辑，但同一事务内）
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
      this.db.prepare(`
        INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)
      `).run(entry.id, entry.content);
      this.db.prepare(`
        INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
      `).run(entry.id, tokenizeWithJieba(entry.content));
      this.db.prepare(`
        INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
        VALUES (?, 0, NULL, 0)
      `).run(entry.id);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * F20260803chunk: 按 source 原子替换多条 entry（1:N，单事务删旧全部+插新 N 条）。
   * 用于 chunk 索引：文档 reindex 时删旧全部 chunk + 插新 N 个 chunk。
   * M1：所有 entries 必须同 (sourceTable, sourceId, contentType)，不一致抛异常。
   */
  // eslint-disable-next-line max-lines-per-function -- F20260812mrcq 联动清理 embedding_tasks 增加几行
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

    this.db.exec("BEGIN");
    try {
      // 删旧（同 source + 同 contentType 的全部 entry）
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(sourceTable, sourceId, contentType) as Array<{ id: string }>;
      for (const row of oldRows) {
        this.db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        this.db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(row.id);
        if (this.vecTableExists) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
        // F20260812mrcq Part 1：联动清理 embedding_tasks（不依赖 FK CASCADE，与现有模式一致）
        this.db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?").run(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
      ).run(sourceTable, sourceId, contentType);

      // 插新（N 条 entry，每条独立 entryId）
      for (const entry of entries) {
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
        this.db.prepare(`
          INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)
        `).run(entry.id, entry.content);
        this.db.prepare(`
          INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)
        `).run(entry.id, tokenizeWithJieba(entry.content));
        this.db.prepare(`
          INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
          VALUES (?, 0, NULL, 0)
        `).run(entry.id);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * PR审视 S3-14: 按 source + contentType 删除（body 清空时清理旧 chunk entries）。
   * 复用 replaceEntriesBySource 的 DELETE WHERE 模式（单事务删 entries+fts+vec+weights）。
   */
  async deleteBySourceAndType(sourceTable: string, sourceId: string, contentType: string): Promise<void> {
    this.db.exec("BEGIN");
    try {
      const oldRows = this.db
        .prepare("SELECT id FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?")
        .all(sourceTable, sourceId, contentType) as Array<{ id: string }>;
      for (const row of oldRows) {
        this.db.prepare("DELETE FROM memory_fts WHERE memory_entry_id = ?").run(row.id);
        this.db.prepare("DELETE FROM memory_fts_jieba WHERE memory_entry_id = ?").run(row.id);
        if (this.vecTableExists) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
        // F20260812mrcq Part 1：联动清理 embedding_tasks（不依赖 FK CASCADE，与现有模式一致）
        this.db.prepare("DELETE FROM embedding_tasks WHERE entry_id = ?").run(row.id);
      }
      this.db.prepare(
        "DELETE FROM memory_entries WHERE source_table = ? AND source_id = ? AND content_type = ?"
      ).run(sourceTable, sourceId, contentType);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void> {
    // F20260803mval: vec 扩展不可用时 memory_vec 表不存在，跳过（与 deleteBySource/replaceEntryBySource 一致，S3）
    if (!this.hasVec) return;
    /** vec0 不支持 INSERT OR REPLACE，先删除再插入 */
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(memoryEntryId);
      this.db.prepare(`
        INSERT INTO memory_vec (memory_entry_id, embedding)
        VALUES (?, ?)
      `).run(memoryEntryId, embedding);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare(
      "SELECT * FROM memory_entries WHERE id = ?",
    ).get(id) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
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
    // F20260805hybrid: 使用 jieba 分词表支持中文短查询
    const tokenizedQuery = tokenizeQuery(query);
    if (tokenizedQuery.length === 0) return [];

    const ct = this.buildContentTypeClause(filters);
    const ftsQuery = tokenizedQuery.map((t: string) => escapeFtsQuery(t)).join(" OR ");

    const rows = this.db.prepare(`
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
    ) as FtsRow[];

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

    const ct = this.buildContentTypeClause(filters);
    const ftsQuery = tokenizedQuery.map((t: string) => escapeFtsQuery(t)).join(" OR ");

    const rows = this.db.prepare(`
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
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        UPDATE memory_weights
        SET retrieval_count = retrieval_count + 1, last_retrieved_at = datetime('now')
        WHERE memory_entry_id = ?
      `);
      for (const id of memoryEntryIds) {
        stmt.run(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO embedding_meta (key, value, updated_at) VALUES (?, ?, ?)",
      );
      stmt.run("model_id", meta.modelId, now);
      stmt.run("model_rev", meta.modelRev, now);
      stmt.run("dim", String(meta.dim), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  /**
   * F20260812mrcq Part 1：embedding 失败入队重试。
   * ON CONFLICT(entry_id) DO UPDATE：
   *   - 不重置 attempts（避免无限重试）
   *   - status 强制 'pending'（dead 也可被 enqueueRetry 复活）
   *   - next_retry_at = now（立即可重试）
   */
  async enqueueRetry(entryId: string, error: unknown): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    this.db.prepare(`
      INSERT INTO embedding_tasks (entry_id, next_retry_at, status, created_at, last_error)
      VALUES (?, datetime('now'), 'pending', datetime('now'), ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error,
        status = 'pending'
    `).run(entryId, errMsg);
  }

  /**
   * F20260812mrcq Part 1：原子认领 pending 任务（SQLite 3.35+ RETURNING）。
   * attempts 自增 1（claim 即视为已尝试）。
   * 指数退避：next_retry_at 按 attempts 计算（30s/60s/120s 封顶 1h）。
   * JOIN memory_entries 获取 content（content 不冗余存储）。
   * 若 entry 已被删除（JOIN 不到），claim 返回 content=''，tick 会跳过转 dead。
   */
  async claimPendingTasks(
    limit: number,
  ): Promise<Array<{ entryId: string; content: string; attempts: number }>> {
    const rows = this.db.prepare(`
      UPDATE embedding_tasks
      SET last_attempt_at = datetime('now'),
          next_retry_at = datetime('now', '+' ||
            CASE attempts
              WHEN 0 THEN '30'
              WHEN 1 THEN '60'
              WHEN 2 THEN '120'
              WHEN 3 THEN '300'
              ELSE '3600'
            END || ' seconds'),
          attempts = attempts + 1
      WHERE entry_id IN (
        SELECT entry_id FROM embedding_tasks
        WHERE status = 'pending'
          AND next_retry_at <= datetime('now')
        LIMIT ?
      )
      RETURNING entry_id, attempts
    `).all(limit) as Array<{ entry_id: string; attempts: number }>;

    if (rows.length === 0) return [];
    // 二次查询 JOIN memory_entries 拿 content
    const placeholders = rows.map(() => "?").join(",");
    const entryRows = this.db.prepare(`
      SELECT id, content FROM memory_entries WHERE id IN (${placeholders})
    `).all(...rows.map(r => r.entry_id)) as Array<{ id: string; content: string }>;
    const contentMap = new Map(entryRows.map(r => [r.id, r.content]));
    return rows.map(r => ({
      entryId: r.entry_id,
      content: contentMap.get(r.entry_id) ?? "",
      attempts: r.attempts,
    }));
  }

  /** F20260812mrcq Part 1：task 成功，删除 task 行 */
  async markTaskDone(entryId: string): Promise<void> {
    this.db.prepare(`DELETE FROM embedding_tasks WHERE entry_id = ?`).run(entryId);
  }

  /**
   * F20260812mrcq Part 1：task 失败，更新 last_error。
   * 若 attempts >= maxAttempts，status 转 'dead'（不再被 claimPendingTasks 选取）。
   */
  async markTaskAttemptFailed(entryId: string, error: unknown, maxAttempts: number): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    this.db.prepare(`
      UPDATE embedding_tasks
      SET last_error = ?,
          status = CASE WHEN attempts >= ? THEN 'dead' ELSE status END
      WHERE entry_id = ?
    `).run(errMsg, maxAttempts, entryId);
  }
}
