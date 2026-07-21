import type Database from "better-sqlite3";
import type { FeatureRepository } from "../../../usecases/document/feature-repository";
import type { FeatureDocument, FeatureStatus } from "../../../entities/document/feature";
import { rowToEntity, entityToRow } from "./feature-mapper";
import type { FeatureRow } from "./feature-mapper";

export class SqliteFeatureRepository implements FeatureRepository {
  constructor(private readonly db: Database.Database) {}

  async findById(id: string): Promise<FeatureDocument | null> {
    const row = this.db.prepare("SELECT * FROM features WHERE id = ?").get(id) as FeatureRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async findAll(): Promise<FeatureDocument[]> {
    const rows = this.db.prepare("SELECT * FROM features ORDER BY created_at DESC").all() as FeatureRow[];
    return rows.map(rowToEntity);
  }

  async insert(doc: FeatureDocument): Promise<void> {
    const row = entityToRow(doc);
    this.db.prepare(`
      INSERT INTO features (id, title, summary, change_type, status, tags, modules, causal_links_from, supersedes, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.title,
      row.summary,
      row.change_type,
      row.status,
      row.tags,
      row.modules,
      row.causal_links_from,
      row.supersedes,
      row.file_path,
      row.created_at
    );
  }

  async updateStatus(id: string, status: FeatureStatus): Promise<void> {
    this.db.prepare("UPDATE features SET status = ? WHERE id = ?").run(status, id);
  }
}
