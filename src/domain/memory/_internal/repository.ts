/**
 * SQLite 持久化：memory_entries + memory_fts + memory_weights + memory_vec 表 CRUD。
 *
 * 使用 better-sqlite3 同步 API。
 * storeEntry 在单事务内写入 memory_entries + memory_fts + memory_weights（D27）。
 * vec0 操作在 sqlite-vec 不可用时降级（D22）。
 */

import type Database from "better-sqlite3";
import type {
  FTSHit,
  MemoryEntry,
  MemoryEntryInput,
  MemoryWeight,
  VecHit,
} from "../model";
import {
  bufferToFloat32Array,
  rowToMemoryEntry,
  rowToMemoryWeight,
  type FtsRow,
  type MemoryEntryRow,
  type MemoryWeightRow,
  type VecRow,
} from "./mapper";

interface SearchOpts {
  layer?: string;
  granularity?: string;
  conversationId?: string;
  limit: number;
}

/** FTS5 查询转义：包装为 phrase query，防止特殊字符被解释为操作符（S14） */
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export class MemoryRepository {
  private readonly db: Database.Database;
  /** 构造时缓存，运行期不变（S10） */
  private readonly hasVec: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasVec = this.checkVecTable();
  }

  /** 检查 memory_vec 是否可用（S12: 同时验证表存在和 sqlite-vec 扩展可用） */
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

  // --- Entry CRUD ---

  /** 单事务写入 memory_entries + memory_fts + memory_weights（D27） */
  storeEntry(id: string, entry: MemoryEntryInput): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO memory_entries (id, layer, content_type, source_id, source_table,
          conversation_id, tree_path, granularity, content, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, entry.layer, entry.contentType, entry.sourceId, entry.sourceTable,
        entry.conversationId ?? null, entry.treePath ?? null,
        entry.granularity, entry.content,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );

      this.db.prepare(`
        INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)
      `).run(id, entry.content);

      this.db.prepare(`
        INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
        VALUES (?, 0, NULL, 0)
      `).run(id);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getById(id: string): MemoryEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM memory_entries WHERE id = ?",
    ).get(id) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
  }

  getBySource(sourceTable: string, sourceId: string): MemoryEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM memory_entries WHERE source_table = ? AND source_id = ?",
    ).get(sourceTable, sourceId) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
  }

  updateLayerByConversation(
    conversationId: string,
    fromLayer: string,
    toLayer: string,
  ): void {
    this.db.prepare(`
      UPDATE memory_entries SET layer = ?
      WHERE conversation_id = ? AND layer = ?
    `).run(toLayer, conversationId, fromLayer);
  }

  // --- FTS5 搜索 ---

  searchFTS(query: string, opts: SearchOpts): FTSHit[] {
    const escaped = escapeFtsQuery(query);
    const rows = this.db.prepare(`
      SELECT me.*, fts.rank AS bm25_score
      FROM memory_fts fts
      JOIN memory_entries me ON fts.memory_entry_id = me.id
      WHERE memory_fts MATCH ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
      ORDER BY fts.rank
      LIMIT ?
    `).all(
      escaped,
      opts.layer ?? null, opts.layer ?? null,
      opts.granularity ?? null, opts.granularity ?? null,
      opts.conversationId ?? null, opts.conversationId ?? null,
      opts.limit,
    ) as FtsRow[];

    return rows.map(row => ({
      memoryEntryId: row.id,
      bm25Score: row.bm25_score,
      entry: rowToMemoryEntry(row),
    }));
  }

  // --- vec0 搜索 ---

  searchVec(embedding: Float32Array, opts: SearchOpts): VecHit[] {
    if (!this.hasVec) return [];

    const rows = this.db.prepare(`
      SELECT mv.memory_entry_id, mv.distance, me.*
      FROM memory_vec mv
      JOIN memory_entries me ON mv.memory_entry_id = me.id
      WHERE mv.embedding MATCH ?
        AND k = ?
        AND (? IS NULL OR me.layer = ?)
        AND (? IS NULL OR me.granularity = ?)
        AND (? IS NULL OR me.conversation_id = ?)
      ORDER BY mv.distance
    `).all(
      embedding, opts.limit,
      opts.layer ?? null, opts.layer ?? null,
      opts.granularity ?? null, opts.granularity ?? null,
      opts.conversationId ?? null, opts.conversationId ?? null,
    ) as VecRow[];

    return rows.map(row => ({
      memoryEntryId: row.id,
      distance: row.distance,
      entry: rowToMemoryEntry(row),
    }));
  }

  storeEmbedding(memoryEntryId: string, embedding: Float32Array): void {
    /** vec0 不支持 INSERT OR REPLACE，先删除再插入（事务保证原子性） */
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

  getEmbedding(memoryEntryId: string): Float32Array | null {
    const row = this.db.prepare(
      "SELECT embedding FROM memory_vec WHERE memory_entry_id = ?",
    ).get(memoryEntryId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return bufferToFloat32Array(row.embedding);
  }

  // --- 权重 ---

  getWeight(memoryEntryId: string): MemoryWeight {
    const row = this.db.prepare(
      "SELECT * FROM memory_weights WHERE memory_entry_id = ?",
    ).get(memoryEntryId) as MemoryWeightRow | undefined;
    if (!row) {
      throw new Error(`MemoryWeight not found: ${memoryEntryId}`);
    }
    return rowToMemoryWeight(row);
  }

  getWeights(memoryEntryIds: string[]): Map<string, MemoryWeight> {
    if (memoryEntryIds.length === 0) return new Map();
    const placeholders = memoryEntryIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM memory_weights WHERE memory_entry_id IN (${placeholders})`,
    ).all(...memoryEntryIds) as MemoryWeightRow[];
    const result = new Map<string, MemoryWeight>();
    for (const row of rows) {
      result.set(row.memory_entry_id, rowToMemoryWeight(row));
    }
    return result;
  }

  incrementRetrievalCount(memoryEntryId: string): void {
    this.db.prepare(`
      UPDATE memory_weights
      SET retrieval_count = retrieval_count + 1, last_retrieved_at = datetime('now')
      WHERE memory_entry_id = ?
    `).run(memoryEntryId);
  }

  /** 批量递增检索计数（S15: 事务包裹保证原子性） */
  incrementRetrievalCounts(memoryEntryIds: string[]): void {
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

  flagMemory(memoryEntryId: string, flagged: boolean): void {
    this.db.prepare(`
      UPDATE memory_weights SET user_flagged = ? WHERE memory_entry_id = ?
    `).run(flagged ? 1 : 0, memoryEntryId);
  }
}
