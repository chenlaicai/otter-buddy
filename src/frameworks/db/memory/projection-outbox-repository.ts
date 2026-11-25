import type Database from "better-sqlite3";
import { ENTRY_MEMORY_POLICY_VERSION } from "@usecases/memory/entry-projection-policy";
import type { EntryProjectionOutbox, ProjectionOutboxTask } from "@usecases/memory/entry-projection-worker";

interface ProjectionOutboxRow {
  entry_id: string;
  conversation_id: string;
  attachment_intent_json: string | null;
  attempts: number;
  created_at: string;
}

function attachmentIds(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function toTask(row: ProjectionOutboxRow): ProjectionOutboxTask {
  return {
    entryId: row.entry_id,
    conversationId: row.conversation_id,
    attachmentIntentIds: attachmentIds(row.attachment_intent_json),
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

/** 与 entries 同事务调用；SQL SELECT 保证只给真实 user/speak 源行建投递凭据。 */
export function enqueueProjectionOutbox(
  db: Database.Database,
  entryId: string,
  attachmentIntentIds?: string[],
  nowIso = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO memory_projection_outbox (
      entry_id, conversation_id, attachment_intent_json, policy_version,
      status, attempts, next_retry_at, last_error, created_at, updated_at
    )
    SELECT id, conversation_id, ?, ?, 'pending', 0, created_at, NULL, created_at, ?
    FROM entries WHERE id = ? AND entry_type IN ('user', 'speak')
    ON CONFLICT(entry_id) DO UPDATE SET
      attachment_intent_json = COALESCE(excluded.attachment_intent_json, memory_projection_outbox.attachment_intent_json),
      policy_version = excluded.policy_version,
      status = 'pending', attempts = 0, next_retry_at = excluded.next_retry_at,
      last_error = NULL, updated_at = excluded.updated_at
  `).run(attachmentIntentIds === undefined ? null : JSON.stringify(attachmentIntentIds), ENTRY_MEMORY_POLICY_VERSION, nowIso, entryId);
}

/** 对账确认终态时补登缺失行，不将兼容回滚的同 hash 直写重复投影。 */
export function recordProjectionOutboxTerminal(
  db: Database.Database,
  entryId: string,
  status: "done" | "skipped",
  attachmentIntentIds: string[],
  nowIso: string,
): void {
  db.prepare(`
    INSERT INTO memory_projection_outbox (
      entry_id, conversation_id, attachment_intent_json, policy_version,
      status, attempts, next_retry_at, last_error, created_at, updated_at
    )
    SELECT id, conversation_id, ?, ?, ?, 0, created_at, NULL, created_at, ?
    FROM entries WHERE id = ? AND entry_type IN ('user', 'speak')
    ON CONFLICT(entry_id) DO UPDATE SET
      status = excluded.status, last_error = NULL, updated_at = excluded.updated_at
  `).run(JSON.stringify(attachmentIntentIds), ENTRY_MEMORY_POLICY_VERSION, status, nowIso, entryId);
}

export class SqliteProjectionOutboxRepository implements EntryProjectionOutbox {
  constructor(private readonly db: Database.Database) {}

  claimDue(nowIso: string, limit: number): ProjectionOutboxTask[] {
    const rows = this.db.prepare(`
      SELECT entry_id, conversation_id, attachment_intent_json, attempts, created_at
      FROM memory_projection_outbox
      WHERE status = 'pending' AND next_retry_at <= ?
      ORDER BY created_at, entry_id LIMIT ?
    `).all(nowIso, limit) as ProjectionOutboxRow[];
    return rows.map(toTask);
  }

  markDone(entryId: string, nowIso: string): void {
    this.db.prepare("UPDATE memory_projection_outbox SET status = 'done', last_error = NULL, updated_at = ? WHERE entry_id = ?")
      .run(nowIso, entryId);
  }

  markSkipped(entryId: string, nowIso: string, reason?: string): void {
    this.db.prepare("UPDATE memory_projection_outbox SET status = 'skipped', last_error = ?, updated_at = ? WHERE entry_id = ?")
      .run(reason ?? null, nowIso, entryId);
  }

  markFailed(entryId: string, error: string, now: Date, maxAttempts: number): void {
    const row = this.db.prepare("SELECT attempts FROM memory_projection_outbox WHERE entry_id = ?").get(entryId) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    const status = attempts >= maxAttempts ? "dead" : "pending";
    const backoffMs = Math.min(300_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
    const nextRetryAt = new Date(now.getTime() + backoffMs).toISOString();
    this.db.prepare(`
      UPDATE memory_projection_outbox
      SET status = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE entry_id = ?
    `).run(status, attempts, nextRetryAt, error.slice(0, 1000), now.toISOString(), entryId);
  }
}
