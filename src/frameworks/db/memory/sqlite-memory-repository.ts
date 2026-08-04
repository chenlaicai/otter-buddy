import type Database from "better-sqlite3";
import type { MemoryEntry, MemoryWeight, MemoryLayer } from "@entities/memory/memory-entry";
import type {
  FTSHit,
  MemoryRepository,
  SearchFilters,
  VecHit,
} from "@usecases/memory/memory-repository";
import {
  bufferToFloat32Array,
  rowToMemoryEntry,
  rowToMemoryWeight,
  rowToSnippetHit,
  type FtsRow,
  type FtsHighlightRow,
  type MemoryEntryRow,
  type MemoryWeightRow,
  type VecRow,
} from "./memory-mapper";
import type { SnippetHit } from "@usecases/memory/memory-repository";

import { escapeFtsQuery } from "../fts-utils";

const DEFAULT_FTS_LIMIT = 50;
const MAX_GET_DETAILS_BATCH = 100;

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: Database.Database;
  /** 构造时缓存，运行期不变 */
  private readonly hasVec: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasVec = this.checkVecTable();
  }

  /** 检查 memory_vec 是否可用 */
  private checkVecTable(): boolean {
    try {
      this.db.prepare("SELECT 1 FROM memory_vec LIMIT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  hasVecTable(): boolean {
    return this.hasVec;
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
        // F20260803mval: memory_vec 是 vec0 虚拟表，sqlite-vec 扩展不可用时表不存在（D22 降级），删除前检查
        if (this.hasVec) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
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
        if (this.hasVec) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
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
        if (this.hasVec) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
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
        if (this.hasVec) {
          this.db.prepare("DELETE FROM memory_vec WHERE memory_entry_id = ?").run(row.id);
        }
        this.db.prepare("DELETE FROM memory_weights WHERE memory_entry_id = ?").run(row.id);
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
    const escaped = escapeFtsQuery(query);
    const ct = this.buildContentTypeClause(filters);
    const rows = this.db.prepare(`
      SELECT me.*, fts.rank AS bm25_score
      FROM memory_fts fts
      JOIN memory_entries me ON fts.memory_entry_id = me.id
      WHERE memory_fts MATCH ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
        ${ct.clause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(
      escaped,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
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
    const escaped = escapeFtsQuery(query);
    const ct = this.buildContentTypeClause(filters);
    const rows = this.db.prepare(`
      SELECT me.*, fts.rank AS bm25_score, highlight(memory_fts, 1, '<b>', '</b>') AS snippet
      FROM memory_fts fts
      JOIN memory_entries me ON fts.memory_entry_id = me.id
      WHERE memory_fts MATCH ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
        ${ct.clause}
      ORDER BY fts.rank
      LIMIT ?
    `).all(
      escaped,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
      ...ct.params,
      DEFAULT_FTS_LIMIT,
    ) as FtsHighlightRow[];

    return rows.map(rowToSnippetHit);
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
        ${ct.clause}
      ORDER BY mv.distance
    `).all(
      embedding, limit,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
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
}
