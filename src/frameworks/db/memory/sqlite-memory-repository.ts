import type Database from "better-sqlite3";
import type { MemoryEntry, MemoryLayer, MemoryWeight } from "@entities/memory/memory-entry";
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

/** FTS5 查询转义：包装为 phrase query，防止特殊字符被解释为操作符 */
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

const DEFAULT_FTS_LIMIT = 50;

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

  async storeEmbedding(memoryEntryId: string, embedding: Float32Array): Promise<void> {
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
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM memory_entries WHERE id IN (${placeholders})`,
    ).all(...ids) as MemoryEntryRow[];
    return rows.map(rowToMemoryEntry);
  }

  async getBySource(sourceTable: string, sourceId: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare(
      "SELECT * FROM memory_entries WHERE source_table = ? AND source_id = ?",
    ).get(sourceTable, sourceId) as MemoryEntryRow | undefined;
    return row ? rowToMemoryEntry(row) : null;
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
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
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
    const rows = this.db.prepare(`
      SELECT me.*, fts.rank AS bm25_score, highlight(memory_fts, 1, '<b>', '</b>') AS snippet
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
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
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
      embedding, limit,
      filters.layer ?? null, filters.layer ?? null,
      filters.granularity ?? null, filters.granularity ?? null,
      filters.conversationId ?? null, filters.conversationId ?? null,
    ) as VecRow[];

    return rows.map(row => ({
      entryId: row.id,
      distance: row.distance,
      entry: rowToMemoryEntry(row),
    }));
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
