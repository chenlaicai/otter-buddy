/**
 * 附件仓储 SQLite 实现（多模态 Phase 1）。
 */

import type Database from "better-sqlite3";
import { DomainError } from "@entities/errors";
import type { Attachment, AttachmentRef } from "@entities/conversation/attachment";
import type { AttachmentRepository } from "@usecases/conversation/attachment-repository";

/** sha256+uploader 撞唯一索引：携带已存在行，上传管线直接返回已有 id（去重语义） */
export class AttachmentDuplicateError extends DomainError {
  constructor(public readonly existing: Attachment) {
    super(`Attachment duplicate: sha256=${existing.sha256} uploader=${existing.uploaderId}`, "conflict");
  }
}

interface AttachmentRow {
  id: string;
  sha256: string;
  file_path: string;
  original_name: string;
  mime_type: string;
  kind: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  uploader_id: string;
  created_at: string;
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    sha256: row.sha256,
    filePath: row.file_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    kind: row.kind as Attachment["kind"],
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    caption: row.caption,
    uploaderId: row.uploader_id,
    createdAt: row.created_at,
  };
}

function rowToRef(row: AttachmentRow): AttachmentRef {
  return {
    id: row.id,
    kind: row.kind as Attachment["kind"],
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    caption: row.caption,
  };
}

const SELECT_COLS = "id, sha256, file_path, original_name, mime_type, kind, size_bytes, width, height, caption, uploader_id, created_at";

export class SqliteAttachmentRepository implements AttachmentRepository {
  constructor(private readonly db: Database.Database) {}

  async insert(attachment: Attachment): Promise<void> {
    try {
      this.db.prepare(`
        INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, width, height, caption, uploader_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachment.id, attachment.sha256, attachment.filePath, attachment.originalName,
        attachment.mimeType, attachment.kind, attachment.sizeBytes,
        attachment.width, attachment.height, attachment.caption,
        attachment.uploaderId, attachment.createdAt,
      );
    } catch (err) {
      // better-sqlite3 唯一冲突消息："UNIQUE constraint failed: attachments.sha256, attachments.uploader_id"（复合索引不带索引名）
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: attachments.sha256")) {
        const existing = await this.findBySha256(attachment.sha256, attachment.uploaderId);
        if (existing) throw new AttachmentDuplicateError(existing);
      }
      throw err;
    }
  }

  async findBySha256(sha256: string, uploaderId: string): Promise<Attachment | null> {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM attachments WHERE sha256 = ? AND uploader_id = ?`,
    ).get(sha256, uploaderId) as AttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  async getById(id: string): Promise<Attachment | null> {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM attachments WHERE id = ?`,
    ).get(id) as AttachmentRow | undefined;
    return row ? rowToAttachment(row) : null;
  }

  async getByIds(ids: string[]): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLS} FROM attachments WHERE id IN (${placeholders})`,
    ).all(...ids) as AttachmentRow[];
    return rows.map(rowToAttachment);
  }

  async linkMessageAttachments(messageId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    this.db.transaction(() => {
      const stmt = this.db.prepare(
        "INSERT INTO message_attachments (message_id, attachment_id, sequence_num) VALUES (?, ?, ?)",
      );
      attachmentIds.forEach((attachmentId, index) => stmt.run(messageId, attachmentId, index));
    })();
  }

  async getAttachmentRefsByMessageIds(messageIds: string[]): Promise<Map<string, AttachmentRef[]>> {
    const result = new Map<string, AttachmentRef[]>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT ma.message_id AS message_id, a.id, a.sha256, a.file_path, a.original_name, a.mime_type, a.kind, a.size_bytes, a.width, a.height, a.caption, a.uploader_id, a.created_at
      FROM message_attachments ma
      JOIN attachments a ON a.id = ma.attachment_id
      WHERE ma.message_id IN (${placeholders})
      ORDER BY ma.sequence_num ASC
    `).all(...messageIds) as Array<AttachmentRow & { message_id: string }>;
    for (const row of rows) {
      const arr = result.get(row.message_id) ?? [];
      arr.push(rowToRef(row));
      result.set(row.message_id, arr);
    }
    return result;
  }
}
