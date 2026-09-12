import type Database from "better-sqlite3";
import type {
  Entry,
  EntryStatus,
  EntryType,
  EntrySource,
  EntryMetadata,
  SenderType,
} from "@entities/conversation/entry";
import type {
  EntryRepository,
  GetEntriesOptions,
} from "@usecases/conversation/entry-repository";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import { escapeFtsQuery } from "../fts-utils";

/** Entry 表行类型 */
interface EntryRow {
  id: string;
  conversation_id: string;
  sequence_num: number;
  entry_type: string;
  sender_type: string | null;
  sender_id: string | null;
  body: string | null;
  invoke_id: string | null;
  yield_targets: string | null;
  turn_id: string;
  status: string;
  source: string | null;
  metadata: string | null;
  sender_name: string;
  context_tokens: number | null;
  context_tokens_max: number | null;
  created_at: string;
  completed_at: string | null;
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequenceNum: row.sequence_num,
    entryType: row.entry_type as EntryType,
    senderType: row.sender_type as SenderType | null,
    senderId: row.sender_id,
    body: row.body,
    invokeId: row.invoke_id,
    yieldTargets: row.yield_targets
      ? (JSON.parse(row.yield_targets) as string[])
      : null,
    turnId: row.turn_id,
    status: row.status as EntryStatus,
    source: (row.source ?? null) as EntrySource,
    metadata: row.metadata ? (JSON.parse(row.metadata) as EntryMetadata) : null,
    senderName: row.sender_name ?? "",
    contextTokens: row.context_tokens,
    contextTokensMax: row.context_tokens_max,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class SqliteEntryRepository implements EntryRepository {
  constructor(private readonly db: Database.Database) {}

  async createEntry(entry: Entry): Promise<void> {
    this.db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, turn_id, status, source, metadata,
        sender_name, context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.conversationId, entry.sequenceNum, entry.entryType,
      entry.senderType, entry.senderId, entry.body, entry.invokeId,
      entry.yieldTargets ? JSON.stringify(entry.yieldTargets) : null,
      entry.turnId, entry.status, entry.source,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.senderName, entry.contextTokens, entry.contextTokensMax,
      entry.createdAt, entry.completedAt,
    );
    this.upsertEntryFts(entry.id, entry.body ?? "");
  }

  async createEntries(entries: Entry[]): Promise<void> {
    const insert = this.db.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, turn_id, status, source, metadata,
        sender_name, context_tokens, context_tokens_max, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(
      "INSERT INTO entries_fts (entry_id, body) VALUES (?, ?)",
    );
    this.db.transaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.id, entry.conversationId, entry.sequenceNum, entry.entryType,
          entry.senderType, entry.senderId, entry.body, entry.invokeId,
          entry.yieldTargets ? JSON.stringify(entry.yieldTargets) : null,
          entry.turnId, entry.status, entry.source,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.senderName, entry.contextTokens, entry.contextTokensMax,
          entry.createdAt, entry.completedAt,
        );
        insertFts.run(entry.id, stripHtmlCardFences(entry.body ?? ""));
      }
    })();
  }

  /** F20260910ctlv 彻底切换：原子序号插入（INSERT ... SELECT MAX+1，消灭读后写竞态） */
  async createEntryAtomic(entry: Entry): Promise<Entry> {
    const insertSql = `
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, turn_id, status, source, metadata,
        sender_name, context_tokens, context_tokens_max, created_at, completed_at
      )
      SELECT ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM entries WHERE conversation_id = ?
    `;
    const params = [
      entry.id, entry.conversationId, entry.entryType,
      entry.senderType, entry.senderId, entry.body, entry.invokeId,
      entry.yieldTargets ? JSON.stringify(entry.yieldTargets) : null,
      entry.turnId, entry.status, entry.source,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.senderName, entry.contextTokens, entry.contextTokensMax,
      entry.createdAt, entry.completedAt,
      entry.conversationId,
    ];
    this.db.transaction(() => {
      this.db.prepare(insertSql).run(...params);
      this.upsertEntryFts(entry.id, entry.body ?? "");
    })();
    const created = await this.getEntryById(entry.id);
    return created ?? entry;
  }

  /** F20260910ctlv 彻底切换：原子序号批量插入（事务内逐条 MAX+1） */
  async createEntriesAtomic(entries: Entry[]): Promise<Entry[]> {
    if (entries.length === 0) return [];
    const insertSql = `
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, invoke_id, yield_targets, turn_id, status, source, metadata,
        sender_name, context_tokens, context_tokens_max, created_at, completed_at
      )
      SELECT ?, ?, COALESCE(MAX(sequence_num), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM entries WHERE conversation_id = ?
    `;
    this.db.transaction(() => {
      for (const entry of entries) {
        this.db.prepare(insertSql).run(
          entry.id, entry.conversationId, entry.entryType,
          entry.senderType, entry.senderId, entry.body, entry.invokeId,
          entry.yieldTargets ? JSON.stringify(entry.yieldTargets) : null,
          entry.turnId, entry.status, entry.source,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.senderName, entry.contextTokens, entry.contextTokensMax,
          entry.createdAt, entry.completedAt,
          entry.conversationId,
        );
        this.upsertEntryFts(entry.id, entry.body ?? "");
      }
    })();
    const result: Entry[] = [];
    for (const entry of entries) {
      const created = await this.getEntryById(entry.id);
      result.push(created ?? entry);
    }
    return result;
  }

  async updateEntryStatus(
    entryId: string,
    status: EntryStatus,
    completedAt?: string,
  ): Promise<void> {
    if (completedAt) {
      this.db.prepare(
        "UPDATE entries SET status = ?, completed_at = ? WHERE id = ?",
      ).run(status, completedAt, entryId);
    } else {
      this.db.prepare(
        "UPDATE entries SET status = ? WHERE id = ?",
      ).run(status, entryId);
    }
  }

  async updateEntryBody(entryId: string, body: string): Promise<void> {
    this.db.prepare("UPDATE entries SET body = ? WHERE id = ?").run(body, entryId);
    this.upsertEntryFts(entryId, body);
  }

  /** F20260910ctlv 信号销账：consumed 标记写 metadata */
  async updateEntryMetadata(entryId: string, metadata: EntryMetadata): Promise<void> {
    this.db.prepare("UPDATE entries SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), entryId);
  }

  async updateEntryInvokeId(entryId: string, invokeId: string): Promise<void> {
    this.db.prepare("UPDATE entries SET invoke_id = ? WHERE id = ?").run(invokeId, entryId);
  }

  async getEntryById(id: string): Promise<Entry | null> {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | undefined;
    if (!row) return null;
    const entry = rowToEntry(row);
    await this.attachAttachments([entry]);
    return entry;
  }

  async getEntries(
    conversationId: string,
    options?: GetEntriesOptions,
  ): Promise<Entry[]> {
    const limit = options?.limit ?? 50;
    const conditions: string[] = ["conversation_id = ?"];
    const params: unknown[] = [conversationId];

    this.addOptionalCondition(conditions, params, "status", options?.status);
    this.addOptionalCondition(conditions, params, "sender_type", options?.senderType);
    this.addOptionalCondition(conditions, params, "turn_id", options?.turnId);
    this.addOptionalCondition(conditions, params, "entry_type", options?.entryType);
    if (options?.before) {
      conditions.push("sequence_num < (SELECT sequence_num FROM entries WHERE id = ?)");
      params.push(options.before);
    }

    const sql = `SELECT * FROM entries WHERE ${conditions.join(" AND ")} ORDER BY sequence_num DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  private addOptionalCondition(
    conditions: string[],
    params: unknown[],
    column: string,
    value: unknown,
  ): void {
    if (value !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  }

  /** F20260910ctlv 彻底切换：按 turn 查 entries（turn 聚合目标/self-yield 护栏数据源） */
  async getEntriesByTurnId(turnId: string, entryType?: EntryType): Promise<Entry[]> {
    const sql = entryType
      ? "SELECT * FROM entries WHERE turn_id = ? AND entry_type = ? ORDER BY sequence_num ASC"
      : "SELECT * FROM entries WHERE turn_id = ? ORDER BY sequence_num ASC";
    const rows = (entryType
      ? this.db.prepare(sql).all(turnId, entryType)
      : this.db.prepare(sql).all(turnId)) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  async getEntriesBefore(entryId: string, count: number): Promise<Entry[]> {
    const entry = this.db.prepare("SELECT sequence_num, conversation_id FROM entries WHERE id = ?")
      .get(entryId) as { sequence_num: number; conversation_id: string } | undefined;
    if (!entry) return [];

    const rows = this.db.prepare(
      "SELECT * FROM entries WHERE conversation_id = ? AND sequence_num < ? ORDER BY sequence_num DESC LIMIT ?",
    ).all(entry.conversation_id, entry.sequence_num, count) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  async getEntriesAfter(entryId: string, count: number): Promise<Entry[]> {
    const entry = this.db.prepare("SELECT sequence_num, conversation_id FROM entries WHERE id = ?")
      .get(entryId) as { sequence_num: number; conversation_id: string } | undefined;
    if (!entry) return [];

    const rows = this.db.prepare(
      "SELECT * FROM entries WHERE conversation_id = ? AND sequence_num > ? ORDER BY sequence_num ASC LIMIT ?",
    ).all(entry.conversation_id, entry.sequence_num, count) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  /**
   * F20260910ctlv 彻底切换：獭未读注入数据源——entries 表。
   * 游标：conversation_participants.last_read_seq（语义切到 entries.sequence_num）。
   * 注入内容：user / system / speak entries（排除自己）——未终态条目排除。
   */
  async getUnreadEntries(conversationId: string, otterId: string): Promise<Entry[]> {
    const participant = this.db.prepare(`
      SELECT last_read_seq FROM conversation_participants
      WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
    `).get(conversationId, otterId) as { last_read_seq: number | null } | undefined;
    if (!participant || participant.last_read_seq == null) return [];

    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE conversation_id = ? AND sequence_num > ?
        AND sender_id != ?
        AND entry_type IN ('user', 'system', 'speak')
        AND status = 'completed'
      ORDER BY sequence_num ASC
    `).all(conversationId, participant.last_read_seq, otterId) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  async getMaxSequenceNum(conversationId: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT MAX(sequence_num) as max_seq FROM entries WHERE conversation_id = ?",
    ).get(conversationId) as { max_seq: number | null };
    return row.max_seq ?? 0;
  }

  /** F20260910ctlv 批4a：metadata.externalId(s) 查重（招聘桥接入站去重） */
  async findByExternalId(externalId: string): Promise<Entry | null> {
    const row = this.db.prepare(`
      SELECT * FROM entries WHERE
        JSON_EXTRACT(metadata, '$.externalId') = ?
        OR EXISTS (SELECT 1 FROM JSON_EACH(JSON_EXTRACT(metadata, '$.externalIds')) WHERE value = ?)
      LIMIT 1
    `).get(externalId, externalId) as EntryRow | undefined;
    if (!row) return null;
    const entry = rowToEntry(row);
    await this.attachAttachments([entry]);
    return entry;
  }

  async searchEntries(
    conversationId: string,
    query: string,
    limit = 20,
  ): Promise<Entry[]> {
    const ftsQuery = escapeFtsQuery(query);
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      INNER JOIN entries_fts f ON e.id = f.entry_id
      WHERE e.conversation_id = ? AND entries_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(conversationId, ftsQuery, limit) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  async attachAttachment(
    entryId: string,
    attachmentId: string,
    sequenceNum = 0,
  ): Promise<void> {
    this.db.prepare(
      "INSERT OR IGNORE INTO entry_attachments (entry_id, attachment_id, sequence_num) VALUES (?, ?, ?)",
    ).run(entryId, attachmentId, sequenceNum);
  }

  async getAttachments(
    entryId: string,
  ): Promise<Array<{ attachmentId: string; sequenceNum: number }>> {
    const rows = this.db.prepare(
      "SELECT attachment_id, sequence_num FROM entry_attachments WHERE entry_id = ? ORDER BY sequence_num",
    ).all(entryId) as Array<{ attachment_id: string; sequence_num: number }>;
    return rows.map(r => ({ attachmentId: r.attachment_id, sequenceNum: r.sequence_num }));
  }

  async getInFlightEntries(conversationId: string): Promise<Entry[]> {
    const rows = this.db.prepare(
      "SELECT * FROM entries WHERE conversation_id = ? AND status IN ('streaming', 'speaking') ORDER BY sequence_num",
    ).all(conversationId) as EntryRow[];
    const entries = rows.map(rowToEntry);
    await this.attachAttachments(entries);
    return entries;
  }

  async failInFlightEntries(
    failedAt: string,
    noticeBody: string,
    skipEntryIds?: ReadonlySet<string>,
  ): Promise<number> {
    const inFlight = this.db.prepare(
      "SELECT id, conversation_id, turn_id, sequence_num FROM entries WHERE status IN ('streaming', 'speaking')",
    ).all() as Array<{ id: string; conversation_id: string; turn_id: string; sequence_num: number }>;

    if (inFlight.length === 0) return 0;

    let count = 0;
    this.db.transaction(() => {
      for (const entry of inFlight) {
        this.db.prepare(
          "UPDATE entries SET status = 'failed', completed_at = ? WHERE id = ?",
        ).run(failedAt, entry.id);

        if (!skipEntryIds?.has(entry.id)) {
          const noticeId = `notice-${entry.id}`;
          const maxSeq = this.db.prepare(
            "SELECT MAX(sequence_num) as max_seq FROM entries WHERE conversation_id = ?",
          ).get(entry.conversation_id) as { max_seq: number };
          const newSeq = (maxSeq.max_seq ?? 0) + 1;

          this.db.prepare(`
            INSERT INTO entries (
              id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
              body, turn_id, status, sender_name, created_at, completed_at
            ) VALUES (?, ?, ?, 'system', 'system', 'system', ?, ?, 'completed', 'system', ?, ?)
          `).run(
            noticeId, entry.conversation_id, newSeq, noticeBody,
            entry.turn_id, failedAt, failedAt,
          );
          this.upsertEntryFts(noticeId, noticeBody);
        }
        count++;
      }
    })();
    return count;
  }

  private upsertEntryFts(entryId: string, body: string): void {
    this.db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(entryId);
    this.db.prepare("INSERT INTO entries_fts (entry_id, body) VALUES (?, ?)")
      .run(entryId, stripHtmlCardFences(body));
  }

  private async attachAttachments(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (entry.entryType === "speak" || entry.entryType === "user") {
        const attRows = this.db.prepare(`
          SELECT a.kind, a.original_name, a.size_bytes, a.caption
          FROM entry_attachments ea JOIN attachments a ON a.id = ea.attachment_id
          WHERE ea.entry_id = ? ORDER BY ea.sequence_num ASC
        `).all(entry.id) as Array<{
          kind: string;
          original_name: string;
          size_bytes: number;
          caption: string | null;
        }>;
        if (attRows.length > 0) {
          entry.attachments = attRows.map(r => ({
            id: "",
            kind: r.kind as "image" | "document" | "audio" | "video",
            originalName: r.original_name,
            mimeType: "",
            sizeBytes: r.size_bytes,
            width: null,
            height: null,
            caption: r.caption,
          }));
        }
      }
    }
  }
}
