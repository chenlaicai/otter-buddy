import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  ConversationParticipant,
  LinkedResource,
} from "@entities/conversation/conversation";
import {
  rowToLinkedResource,
  rowToParticipant,
  type LinkedResourceRow,
  type ParticipantRow,
} from "./conversation-mapper";

/**
 * Key Resources + Participant 相关的 repository 方法（从 SqliteConversationRepository 提取）。
 * 纯函数集合，通过 bind(this) 或直接调用使用。
 */

export function linkResource(db: Database.Database, resource: LinkedResource): void {
  db.prepare(`
    INSERT INTO linked_resources (id, conversation_id, resource_type, url, title, content, category, user_flagged, metadata, linked_by, otter_id, auto_linked, created_at, status, linked_at_turn_number, status_changed_at_turn_number, group_id, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resource.id, resource.conversationId, resource.resourceType, resource.url,
    resource.title, resource.content, resource.category, resource.userFlagged ? 1 : 0,
    resource.metadata ? JSON.stringify(resource.metadata) : null,
    resource.linkedBy, resource.otterId, resource.autoLinked ? 1 : 0,
    resource.createdAt, resource.status, resource.linkedAtTurnNumber,
    resource.statusChangedAtTurnNumber, resource.groupId, resource.supersededBy,
  );
}

export function getLinkedResources(db: Database.Database, conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): LinkedResource[] {
  let sql = "SELECT * FROM linked_resources WHERE conversation_id = ?";
  const params: (string | number)[] = [conversationId];

  if (filters?.status) {
    sql += " AND status = ?";
    params.push(filters.status);
  }

  if (filters?.resourceType) {
    sql += " AND resource_type = ?";
    params.push(filters.resourceType);
  }

  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as LinkedResourceRow[];
  return rows.map(rowToLinkedResource);
}

export function getLinkedResourceById(db: Database.Database, id: string): LinkedResource | null {
  const row = db.prepare("SELECT * FROM linked_resources WHERE id = ?").get(id) as LinkedResourceRow | undefined;
  return row ? rowToLinkedResource(row) : null;
}

export function getLinkedResourcesByGroup(db: Database.Database, conversationId: string, groupId: string): LinkedResource[] {
  const rows = db.prepare(
    "SELECT * FROM linked_resources WHERE conversation_id = ? AND group_id = ? ORDER BY created_at ASC",
  ).all(conversationId, groupId) as LinkedResourceRow[];
  return rows.map(rowToLinkedResource);
}

export function updateResourceStatus(db: Database.Database, id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): void {
  const result = db.prepare(`
    UPDATE linked_resources
    SET status = ?, status_changed_at_turn_number = ?, superseded_by = COALESCE(?, superseded_by)
    WHERE id = ? AND status != 'archived'
  `).run(status, statusChangedAtTurnNumber, supersededBy ?? null, id);

  if (result.changes === 0) {
    throw new Error(`LinkedResource ${id} not found or already archived`);
  }
}

export function supersedeLinkedResource(db: Database.Database, existingId: string, newResource: LinkedResource, statusChangedAtTurnNumber: number): void {
  db.exec("BEGIN");
  try {
    linkResource(db, newResource);

    const result = db.prepare(`
      UPDATE linked_resources
      SET status = 'superseded', status_changed_at_turn_number = ?, superseded_by = ?
      WHERE id = ? AND status != 'archived'
    `).run(statusChangedAtTurnNumber, newResource.id, existingId);

    if (result.changes === 0) {
      throw new Error(`LinkedResource ${existingId} not found or already archived`);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteLinkedResource(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM linked_resources WHERE id = ?").run(id);
}

export function flagResource(db: Database.Database, id: string, flagged: boolean): void {
  db.prepare("UPDATE linked_resources SET user_flagged = ? WHERE id = ?").run(flagged ? 1 : 0, id);
}

export function createParticipant(db: Database.Database, participant: ConversationParticipant): void {
  db.prepare(`
    INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
      joined_at_turn_number, status, created_at, last_read_turn_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    participant.id, participant.conversationId, participant.otterId,
    participant.joinedAtTurnId, participant.joinedAtTurnNumber,
    participant.status, participant.createdAt,
    participant.lastReadTurnNumber ?? 0,
  );
}

export function createParticipants(db: Database.Database, participants: ConversationParticipant[]): void {
  if (participants.length === 0) return;
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
        joined_at_turn_number, status, created_at, last_read_turn_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of participants) {
      stmt.run(p.id, p.conversationId, p.otterId, p.joinedAtTurnId, p.joinedAtTurnNumber, p.status, p.createdAt, p.lastReadTurnNumber ?? 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getParticipant(db: Database.Database, conversationId: string, otterId: string): ConversationParticipant | null {
  const row = db.prepare(`
    SELECT * FROM conversation_participants WHERE conversation_id = ? AND otter_id = ? LIMIT 1
  `).get(conversationId, otterId) as ParticipantRow | undefined;
  return row ? rowToParticipant(row) : null;
}

export function getActiveParticipants(db: Database.Database, conversationId: string): ConversationParticipant[] {
  const rows = db.prepare(`
    SELECT * FROM conversation_participants WHERE conversation_id = ? AND status = 'active'
  `).all(conversationId) as ParticipantRow[];
  return rows.map(rowToParticipant);
}

export function updateParticipantLeave(
  db: Database.Database,
  participantId: string,
  leftAtTurnId: string,
  leftAtTurnNumber: number,
  leftAt: string,
): void {
  db.prepare(`
    UPDATE conversation_participants
    SET status = 'left', left_at_turn_id = ?, left_at_turn_number = ?, left_at = ?
    WHERE id = ?
  `).run(leftAtTurnId, leftAtTurnNumber, leftAt, participantId);
}

export function updateLastReadTurnNumber(
  db: Database.Database,
  conversationId: string,
  otterId: string,
  turnNumber: number,
): void {
  db.prepare(`
    UPDATE conversation_participants
    SET last_read_turn_number = ?
    WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
  `).run(turnNumber, conversationId, otterId);
}

export function getUnreadMessages(
  db: Database.Database,
  conversationId: string,
  otterId: string,
): Array<{ id: string; sender_id: string; sender_type: string; body: string | null; sequence_num: number }> {
  const participant = db.prepare(`
    SELECT last_read_turn_number FROM conversation_participants
    WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
  `).get(conversationId, otterId) as { last_read_turn_number: number } | undefined;

  if (!participant) return [];

  /** 排除 streaming/speaking 半成品（body 为 null 或半截 speak 内容，不应注入其它 otter 上下文，F5） */
  return db.prepare(`
    SELECT m.id, m.sender_id, m.sender_type, m.body, m.sequence_num
    FROM messages m
    JOIN turns t ON m.turn_id = t.id
    WHERE m.conversation_id = ? AND t.turn_number >= ? AND m.sender_id != ?
      AND m.status NOT IN ('streaming', 'speaking')
    ORDER BY m.sequence_num ASC
  `).all(conversationId, participant.last_read_turn_number, otterId) as Array<{ id: string; sender_id: string; sender_type: string; body: string | null; sequence_num: number }>;
}
