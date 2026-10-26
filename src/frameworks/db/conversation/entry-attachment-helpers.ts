/**
 * SqliteEntryRepository 的附件与 FTS 维护助手（F20261026ctbg 拆分：主文件超 450 行 lint 上限，
 * 附件读写与 FTS upsert 是独立关注面，抽为模块级函数供仓库类薄委托）。
 */
import type Database from "better-sqlite3";
import type { AttachmentRef } from "@entities/conversation/attachment";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";

export function attachEntryAttachment(db: Database.Database, entryId: string, attachmentId: string, sequenceNum: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO entry_attachments (entry_id, attachment_id, sequence_num) VALUES (?, ?, ?)",
  ).run(entryId, attachmentId, sequenceNum);
}

interface AttachmentJoinRow { attachment_id: string; sequence_num: number }

export function getEntryAttachments(db: Database.Database, entryId: string): Array<{ attachmentId: string; sequenceNum: number }> {
  // F20261026ctbg 审视修复：恢复原实现（无 JOIN）——entry_attachments 本身有 (entry_id, attachment_id)
  // 唯一约束，孤儿关联行在写入路径已排除；JOIN attachments 只会把历史孤儿行静默吞掉，非严格等价
  const rows = db.prepare(
    "SELECT attachment_id, sequence_num FROM entry_attachments WHERE entry_id = ? ORDER BY sequence_num",
  ).all(entryId) as AttachmentJoinRow[];
  return rows.map(r => ({ attachmentId: r.attachment_id, sequenceNum: r.sequence_num }));
}

export function getAttachmentRefsByIds(db: Database.Database, ids: string[]): AttachmentRef[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, kind, original_name, mime_type, size_bytes, width, height, caption FROM attachments WHERE id IN (${placeholders})`,
  ).all(...ids) as Array<{
    id: string; kind: string; original_name: string; mime_type: string;
    size_bytes: number; width: number | null; height: number | null; caption: string | null;
  }>;
  return rows.map(r => ({
    id: r.id,
    kind: r.kind as AttachmentRef["kind"],
    originalName: r.original_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    caption: r.caption,
  }));
}

export function upsertEntryFts(db: Database.Database, entryId: string, body: string): void {
  // F20261026ctbg 审视修复：恢复原实现写法——entries_fts 是 fts5(entry_id UNINDEXED, body)
  // （schema.ts），无 rowid/content 列语义；另原实现有 stripHtmlCardFences 预处理，拆分时一并丢失
  db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(entryId);
  db.prepare("INSERT INTO entries_fts (entry_id, body) VALUES (?, ?)")
    .run(entryId, stripHtmlCardFences(body));
}
