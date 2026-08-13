import type Database from "better-sqlite3";
import type { TerminologyEntry } from "@entities/memory/terminology-entry";
import type { TerminologyRepository } from "@usecases/memory/terminology-repository";
import {
  rowToTerminologyEntry,
  entryToRow,
  type TerminologyEntryRow,
} from "./terminology-mapper";

import { escapeFtsQuery } from "../fts-utils";

export class SqliteTerminologyRepository implements TerminologyRepository {
  constructor(private readonly db: Database.Database) {}

  async add(entry: TerminologyEntry): Promise<void> {
    const row = entryToRow(entry);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO terminology_entries (id, term, aliases, aliases_flat, definition,
          context, examples, category, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.term, row.aliases, row.aliases_flat, row.definition,
        row.context, row.examples, row.category, row.status,
        row.created_at, row.updated_at, row.version,
      );
      this.db.prepare(`
        INSERT INTO terminology_fts (terminology_entry_id, term, aliases_flat, definition, context)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.id, row.term, row.aliases_flat, row.definition, row.context ?? "");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getByTerm(term: string): Promise<TerminologyEntry | null> {
    const row = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE term = ? AND status = 'active'",
    ).get(term) as TerminologyEntryRow | undefined;
    return row ? rowToTerminologyEntry(row) : null;
  }

  async search(query: string, limit: number): Promise<TerminologyEntry[]> {
    /** 1. 精确匹配 */
    const exact = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE (term = ? OR aliases LIKE ?) AND status = 'active'",
    ).get(query, `%${query}%`) as TerminologyEntryRow | undefined;
    if (exact) return [rowToTerminologyEntry(exact)];

    /** 2. 前缀匹配 */
    const prefixRows = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE term LIKE ? AND status = 'active' LIMIT ?",
    ).all(`${query}%`, limit) as TerminologyEntryRow[];
    if (prefixRows.length > 0) return prefixRows.map(rowToTerminologyEntry);

    /** 3. 全文搜索 */
    const escaped = escapeFtsQuery(query);
    const ftsRows = this.db.prepare(`
      SELECT te.*
      FROM terminology_fts fts
      JOIN terminology_entries te ON fts.terminology_entry_id = te.id
      WHERE terminology_fts MATCH ?
        AND te.status = 'active'
      ORDER BY fts.rank
      LIMIT ?
    `).all(escaped, limit) as TerminologyEntryRow[];
    return ftsRows.map(rowToTerminologyEntry);
  }

  /**
   * 种子数据同步：比对差异，新增/更新，保留运行时用户添加的术语。
   * 幂等：多次执行结果相同。
   */
  async syncSeed(entries: TerminologyEntry[]): Promise<void> {
    const now = new Date().toISOString();

    const existingStmt = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE term = ? AND status = 'active'",
    );
    /**
     * F20260813actk 第五轮审视：同 id 改名的兜底匹配。
     * seed 改 term 不改 id 时（如"发言石"→"行动权"），按 term 查 miss 会走 INSERT 撞 PK。
     * 按 id 兜底查到存量行，走 UPDATE 分支（含 term 列更新）。
     */
    const existingByIdStmt = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE id = ? AND status = 'active'",
    );

    this.db.exec("BEGIN");
    try {
      for (const entry of entries) {
        const row = entryToRow(entry);
        const existing = (existingStmt.get(row.term) as TerminologyEntryRow | undefined)
          ?? (existingByIdStmt.get(row.id) as TerminologyEntryRow | undefined);
        this.applySeedRow(existing, row, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 单条种子应用：存量（含同 id 改名）内容相同跳过，不同更新；不存在则新增。FTS 同步重建 */
  private applySeedRow(existing: TerminologyEntryRow | undefined, row: TerminologyEntryRow, now: string): void {
    if (existing) {
      if (
        existing.term === row.term &&
        existing.aliases === row.aliases &&
        existing.definition === row.definition &&
        existing.context === row.context &&
        existing.examples === row.examples &&
        existing.category === row.category
      ) return;

      this.db.prepare(`
        UPDATE terminology_entries
        SET term = ?, aliases = ?, aliases_flat = ?, definition = ?,
            context = ?, examples = ?, category = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(
        row.term, row.aliases, row.aliases_flat, row.definition,
        row.context, row.examples, row.category, now, existing.id,
      );
      this.db.prepare("DELETE FROM terminology_fts WHERE terminology_entry_id = ?").run(existing.id);
      this.rebuildFts(existing.id, row);
      return;
    }

    this.db.prepare(`
      INSERT INTO terminology_entries (id, term, aliases, aliases_flat, definition,
        context, examples, category, status, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.term, row.aliases, row.aliases_flat, row.definition,
      row.context, row.examples, row.category, row.status,
      row.created_at, row.updated_at, row.version,
    );
    this.rebuildFts(row.id, row);
  }

  private rebuildFts(entryId: string, row: TerminologyEntryRow): void {
    this.db.prepare(`
      INSERT INTO terminology_fts (terminology_entry_id, term, aliases_flat, definition, context)
      VALUES (?, ?, ?, ?, ?)
    `).run(entryId, row.term, row.aliases_flat, row.definition, row.context ?? "");
  }
}
