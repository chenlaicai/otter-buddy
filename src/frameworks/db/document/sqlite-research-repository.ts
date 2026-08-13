import type Database from "better-sqlite3";
import type { ResearchRepository } from "../../../usecases/document/research-repository";
import type { ResearchDocument, ResearchStatus } from "../../../entities/document/research";
import { rowToEntity, entityToRow } from "./research-mapper";
import type { ResearchRow } from "./research-mapper";

export class SqliteResearchRepository implements ResearchRepository {
  constructor(private readonly db: Database.Database) {}

  async findById(id: string): Promise<ResearchDocument | null> {
    const row = this.db.prepare("SELECT * FROM research WHERE id = ?").get(id) as ResearchRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async findAll(): Promise<ResearchDocument[]> {
    const rows = this.db.prepare("SELECT * FROM research ORDER BY created_at DESC").all() as ResearchRow[];
    return rows.map(rowToEntity);
  }

  async insert(doc: ResearchDocument): Promise<void> {
    const row = entityToRow(doc);
    this.db.prepare(`
      INSERT INTO research (id, title, summary, body_hash, exploration_type, status, tags, conclusion, causal_links_from, supersedes, file_path, created_at, created_in_conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.title,
      row.summary,
      row.body_hash,
      row.exploration_type,
      row.status,
      row.tags,
      row.conclusion,
      row.causal_links_from,
      row.supersedes,
      row.file_path,
      row.created_at,
      row.created_in_conversation_id,
    );
  }

  async updateStatus(id: string, status: ResearchStatus): Promise<void> {
    this.db.prepare("UPDATE research SET status = ? WHERE id = ?").run(status, id);
  }

  /** F20260803mval: upsert 场景更新文档内容（内容指纹变了） */
  async updateContent(doc: ResearchDocument): Promise<void> {
    const row = entityToRow(doc);
    this.db.prepare(`
      UPDATE research
      SET title = ?, summary = ?, body_hash = ?, exploration_type = ?, status = ?, tags = ?, conclusion = ?,
          causal_links_from = ?, supersedes = ?, file_path = ?, created_at = ?, created_in_conversation_id = ?
      WHERE id = ?
    `).run(
      row.title, row.summary, row.body_hash, row.exploration_type, row.status, row.tags, row.conclusion,
      row.causal_links_from, row.supersedes, row.file_path, row.created_at, row.created_in_conversation_id, row.id
    );
  }

  /** F20260813mrel: 读取文档的对话 provenance */
  async getCreatedInConversationId(id: string): Promise<string | null> {
    const row = this.db.prepare("SELECT created_in_conversation_id FROM research WHERE id = ?")
      .get(id) as { created_in_conversation_id: string | null } | undefined;
    return row?.created_in_conversation_id ?? null;
  }
}
