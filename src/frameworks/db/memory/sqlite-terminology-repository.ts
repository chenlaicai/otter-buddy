import type Database from "better-sqlite3";
import type { TerminologyEntry } from "@entities/memory/terminology-entry";
import type { TerminologyRepository } from "@usecases/memory/terminology-repository";
import {
  rowToTerminologyEntry,
  entryToRow,
  type TerminologyEntryRow,
} from "./terminology-mapper";

/** FTS5 查询转义：包装为 phrase query，防止特殊字符被解释为操作符 */
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

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

  async update(entry: TerminologyEntry): Promise<void> {
    const row = entryToRow(entry);
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare(`
        UPDATE terminology_entries
        SET term = ?, aliases = ?, aliases_flat = ?, definition = ?,
            context = ?, examples = ?, category = ?, status = ?,
            updated_at = ?, version = ?
        WHERE id = ? AND version = ?
      `).run(
        row.term, row.aliases, row.aliases_flat, row.definition,
        row.context, row.examples, row.category, row.status,
        row.updated_at, row.version, row.id, row.version - 1,
      );
      if (result.changes === 0) {
        throw new Error(`Optimistic lock conflict for terminology entry: ${entry.id}`);
      }
      /** FTS5 同步更新：先删后插 */
      this.db.prepare("DELETE FROM terminology_fts WHERE terminology_entry_id = ?").run(row.id);
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

  async getById(id: string): Promise<TerminologyEntry | null> {
    const row = this.db.prepare(
      "SELECT * FROM terminology_entries WHERE id = ?",
    ).get(id) as TerminologyEntryRow | undefined;
    return row ? rowToTerminologyEntry(row) : null;
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

  async seed(entries: TerminologyEntry[]): Promise<void> {
    /** 仅在表为空时执行 */
    const count = this.db.prepare("SELECT COUNT(*) AS cnt FROM terminology_entries").get() as { cnt: number };
    if (count.cnt > 0) return;

    this.db.exec("BEGIN");
    try {
      const insertEntry = this.db.prepare(`
        INSERT INTO terminology_entries (id, term, aliases, aliases_flat, definition,
          context, examples, category, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare(`
        INSERT INTO terminology_fts (terminology_entry_id, term, aliases_flat, definition, context)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        const row = entryToRow(entry);
        insertEntry.run(
          row.id, row.term, row.aliases, row.aliases_flat, row.definition,
          row.context, row.examples, row.category, row.status,
          row.created_at, row.updated_at, row.version,
        );
        insertFts.run(row.id, row.term, row.aliases_flat, row.definition, row.context ?? "");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
