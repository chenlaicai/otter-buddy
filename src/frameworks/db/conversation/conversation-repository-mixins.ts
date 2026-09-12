import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  ConversationParticipant,
  LinkedResource,
  Turn,
} from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import {
  rowToLinkedResource,
  rowToParticipant,
  rowToTurn,
  type LinkedResourceRow,
  type ParticipantRow,
  type TurnRow,
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
  // F20260910ctlv test15：进场游标显式写 0（= 读全部历史，含进场前的大獭发言）。
  // 旧实现 INSERT 不含该列 → NULL → getUnreadEntries 返回空（读不到任何历史，
  // 小獭进场后仍在问「问题是什么」）；重启 backfill 又把 NULL 填成 max seq（读到最新，
  // 同样读不到进场前）。搭档拍板口径：进场游标与进场 system entry 一致——能看到
  // 进场那一刻为止的全部对话。
  db.prepare(`
    INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
      joined_at_turn_number, status, created_at, last_read_turn_number, last_read_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
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
    // F20260910ctlv test15：同 createParticipant——进场游标显式写 0（读全部历史）
    const stmt = db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
        joined_at_turn_number, status, created_at, last_read_turn_number, last_read_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
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

/** F20260902sgp2 S4c：游标 seq 双写（新刻度）。NULL 安全：last_read_seq 列可空，
 *  首次写入直接设值；回滚面 = 旧列 last_read_turn_number 未动，读路径按 NULL 回退。 */
/** #775：seq 刻度存量回填（一次性，停写旧列的前置）。以同会话最大 sequence_num 为
 *  基线回填 last_read_seq=NULL 的行——「读到最新」是双写过渡期 NULL 行的事实状态
 *  （这些行从未走过新路径，若回填 0 会把全部历史当未读，属 rbsg 形态误判）。
 *  幂等：只更新 NULL 行；回滚面 = 回填值与旧列独立，读路径 NULL 回退逻辑保留。
 *  F20260910ctlv 收尾批3：游标刻度切 entries（entries.sequence_num 是新时间线唯一序列；
 *  messages 停写后 MAX(messages.sequence_num) 恒停摆，回填值会错）。 */
export function backfillLastReadSeq(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE conversation_participants
    SET last_read_seq = (
      SELECT COALESCE(MAX(e.sequence_num), 0) FROM entries e WHERE e.conversation_id = conversation_participants.conversation_id
    )
    WHERE last_read_seq IS NULL
  `).run();
  return result.changes;
}

export function updateLastReadSeq(
  db: Database.Database,
  conversationId: string,
  otterId: string,
  seq: number,
): void {
  db.prepare(`
    UPDATE conversation_participants
    SET last_read_seq = ?
    WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
  `).run(seq, conversationId, otterId);
}

/** F20260819idnw：更新最后活跃轮次（小獭发言时） */
export function updateLastActiveTurnNumber(
  db: Database.Database,
  conversationId: string,
  otterId: string,
  turnNumber: number,
): void {
  db.prepare(`
    UPDATE conversation_participants
    SET last_active_turn_number = ?
    WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
  `).run(turnNumber, conversationId, otterId);
}

export function getUnreadMessages(
  db: Database.Database,
  conversationId: string,
  otterId: string,
): Array<{ id: string; sender_id: string; sender_type: string; sequence_num: number; sender_name: string | null; talking_stone_passed_to: string | null }> {
  // F20260902sgp2 S4c 读路径切换：seq 刻度优先（last_read_seq 非空 = 已迁移），
  // NULL 回退 turn 刻度（存量 participants / 双写前的旧行）。回滚面 = 旧列原样保留。
  const participant = db.prepare(`
    SELECT last_read_turn_number, last_read_seq FROM conversation_participants
    WHERE conversation_id = ? AND otter_id = ? AND status = 'active'
  `).get(conversationId, otterId) as { last_read_turn_number: number; last_read_seq: number | null } | undefined;

  if (!participant) return [];

  /** 排除 streaming/speaking 半成品（不应注入其它 otter 上下文，F5）。
   *  F20260826fuid：携带 sender_name（user 消息的飞书姓名快照，群聊多人识别用）。
   *  F20260902uspr：携带 talking_stone_passed_to（SignalRouter 收件箱判别依赖——
   *  此前投影硬编码 null，信号路由器 pendingSignalsFor 恒空，全部入口静默哑火） */
  // F20260910ctlv 收尾批3：读路径切 entries（时间线唯一真相源）。
  // 消费方（dispatch-chain-engine）已走 getUnreadEntries；本方法保留接口兼容，
  // 数据源从 messages 换成 entries——口径与 sqlite-entry-repository.getUnreadEntries 一致。
  if (participant.last_read_seq != null) {
    // seq 刻度（entries.sequence_num 单调序列）
    return db.prepare(`
      SELECT e.id, e.sender_id, e.sender_type, e.sequence_num, e.sender_name, e.yield_targets AS talking_stone_passed_to
      FROM entries e
      WHERE e.conversation_id = ? AND e.sequence_num > ? AND (e.sender_id IS NULL OR e.sender_id != ?)
        AND e.entry_type IN ('user', 'system', 'speak')
        AND e.status = 'completed'
      ORDER BY e.sequence_num ASC
    `).all(conversationId, participant.last_read_seq, otterId) as Array<{ id: string; sender_id: string; sender_type: string; sequence_num: number; sender_name: string | null; talking_stone_passed_to: string | null }>;
  }
  // turn 刻度（存量回退路径；entries.turn_id 关联）
  return db.prepare(`
    SELECT e.id, e.sender_id, e.sender_type, e.sequence_num, e.sender_name, e.yield_targets AS talking_stone_passed_to
    FROM entries e
    JOIN turns t ON e.turn_id = t.id
    WHERE e.conversation_id = ? AND t.turn_number >= ? AND (e.sender_id IS NULL OR e.sender_id != ?)
      AND e.entry_type IN ('user', 'system', 'speak')
      AND e.status = 'completed'
    ORDER BY e.sequence_num ASC
  `).all(conversationId, participant.last_read_turn_number, otterId) as Array<{ id: string; sender_id: string; sender_type: string; sequence_num: number; sender_name: string | null; talking_stone_passed_to: string | null }>;
}

/** F20260803trrf: 按 id 查 turn（不论 status，markBatchRead 在 turn 关闭后反查 turn_number） */
export function getTurnById(db: Database.Database, turnId: string): Turn | null {
  const row = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId) as TurnRow | undefined;
  return row ? rowToTurn(row) : null;
}

/** F20260803trrf: 指定 sender 的最新条目（F20260910ctlv 批3 切 entries；markBatchRead rejected 路径用）。
 *  兼容返回 Message 形状（消费方只读 id/senderId/createdAt/sequenceNum）——
 *  body 从 entry.body 投影为 segments，aggregateBody 还原。 */
export function getLastMessageBySender(db: Database.Database, conversationId: string, senderId: string): Message | null {
  const row = db.prepare(
    `SELECT * FROM entries WHERE conversation_id = ? AND sender_id = ? ORDER BY sequence_num DESC LIMIT 1`,
  ).get(conversationId, senderId) as (EntryAsMessageRow & { body: string | null }) | undefined;
  return row ? entryRowToMessageLike(row) : null;
}

/** F20260826rsme：指定 senderType 的最新条目（批3 切 entries；circuit-break 用户介入检测用） */
export function getLastMessageBySenderType(db: Database.Database, conversationId: string, senderType: string): Message | null {
  const row = db.prepare(
    `SELECT * FROM entries WHERE conversation_id = ? AND sender_type = ? ORDER BY sequence_num DESC LIMIT 1`,
  ).get(conversationId, senderType) as (EntryAsMessageRow & { body: string | null }) | undefined;
  return row ? entryRowToMessageLike(row) : null;
}

/** entry 行 → Message 兼容形状（批3：mixins 读路径切 entries 的适配层。
 *  消费方（circuit-break/tool-factory/resume）只读 id/senderId/senderType/createdAt/
 *  sequenceNum/status；body 投影进 segments 供 aggregateBody。 */
type EntryAsMessageRow = {
  id: string; conversation_id: string; turn_id: string | null;
  sender_type: string | null; sender_id: string | null;
  entry_type: string; sequence_num: number; sender_name: string | null;
  created_at: string; completed_at: string | null; status: string;
  invoke_id: string | null; source: string | null;
};
function entryRowToMessageLike(row: EntryAsMessageRow & { body: string | null }): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id ?? "",
    senderType: (row.sender_type ?? "system") as Message["senderType"],
    senderId: row.sender_id ?? "",
    talkingStonePassedTo: null,
    status: "completed",
    segments: row.body != null ? [{ id: `${row.id}-seg`, messageId: row.id, body: row.body, sequenceNum: 0, createdAt: row.created_at }] : [],
    sequenceNum: row.sequence_num,
    contextTokens: null,
    contextTokensMax: null,
    source: (row.source ?? "web") as Message["source"],
    senderName: row.sender_name ?? "",
    createdAt: row.created_at,
    completedAt: row.completed_at,
    signalMeta: null,
    metadata: null,
  };
}

/** F20260803trrf: 标记 participant 已离开（dissolve_otter 顺带修，不要求 active turn） */
export function markParticipantLeft(db: Database.Database, conversationId: string, otterId: string): void {
  db.prepare(
    `UPDATE conversation_participants SET status = 'left', left_at = datetime('now') WHERE conversation_id = ? AND otter_id = ? AND status = 'active'`,
  ).run(conversationId, otterId);
}
