import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  ConversationParticipant,
  KeyFact,
  LinkedResource,
} from "@entities/conversation/conversation";
import {
  rowToKeyFact,
  rowToLinkedResource,
  rowToParticipant,
  type KeyFactRow,
  type LinkedResourceRow,
  type ParticipantRow,
} from "./conversation-mapper";

/**
 * Key Info + Participant 相关的 repository 方法（从 SqliteConversationRepository 提取）。
 * 纯函数集合，通过 bind(this) 或直接调用使用。
 */

export function linkResource(db: Database.Database, resource: LinkedResource): void {
  db.prepare(`
    INSERT INTO linked_resources (id, conversation_id, resource_type, url, title, metadata, linked_by, otter_id, auto_linked, created_at, status, linked_at_turn_number, status_changed_at_turn_number, group_id, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resource.id, resource.conversationId, resource.resourceType, resource.url,
    resource.title, resource.metadata ? JSON.stringify(resource.metadata) : null,
    resource.linkedBy, resource.otterId, resource.autoLinked ? 1 : 0,
    resource.createdAt, resource.status, resource.linkedAtTurnNumber,
    resource.statusChangedAtTurnNumber, resource.groupId, resource.supersededBy,
  );
}

export function addKeyFact(db: Database.Database, keyFact: KeyFact): void {
  db.prepare(`
    INSERT INTO key_facts (id, conversation_id, content, category, user_flagged, created_by, otter_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    keyFact.id, keyFact.conversationId, keyFact.content, keyFact.category,
    keyFact.userFlagged ? 1 : 0, keyFact.createdBy, keyFact.otterId, keyFact.createdAt,
  );
}

export function getKeyFacts(db: Database.Database, conversationId: string): KeyFact[] {
  const rows = db.prepare(
    "SELECT * FROM key_facts WHERE conversation_id = ? ORDER BY created_at ASC",
  ).all(conversationId) as KeyFactRow[];
  return rows.map(rowToKeyFact);
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

export function deleteKeyFact(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM key_facts WHERE id = ?").run(id);
}

export function flagKeyFact(db: Database.Database, id: string, flagged: boolean): void {
  db.prepare("UPDATE key_facts SET user_flagged = ? WHERE id = ?").run(flagged ? 1 : 0, id);
}

export function deleteLinkedResource(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM linked_resources WHERE id = ?").run(id);
}

export function createParticipant(db: Database.Database, participant: ConversationParticipant): void {
  db.prepare(`
    INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
      joined_at_turn_number, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    participant.id, participant.conversationId, participant.otterId,
    participant.joinedAtTurnId, participant.joinedAtTurnNumber,
    participant.status, participant.createdAt,
  );
}

export function createParticipants(db: Database.Database, participants: ConversationParticipant[]): void {
  if (participants.length === 0) return;
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
        joined_at_turn_number, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of participants) {
      stmt.run(p.id, p.conversationId, p.otterId, p.joinedAtTurnId, p.joinedAtTurnNumber, p.status, p.createdAt);
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
