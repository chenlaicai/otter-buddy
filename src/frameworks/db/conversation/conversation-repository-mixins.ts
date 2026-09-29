import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  ConversationParticipant,
  LinkedResource,
} from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
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
    INSERT INTO linked_resources (id, conversation_id, resource_type, url, title, content, category, user_flagged, metadata, linked_by, otter_id, auto_linked, created_at, status, group_id, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resource.id, resource.conversationId, resource.resourceType, resource.url,
    resource.title, resource.content, resource.category, resource.userFlagged ? 1 : 0,
    resource.metadata ? JSON.stringify(resource.metadata) : null,
    resource.linkedBy, resource.otterId, resource.autoLinked ? 1 : 0,
    resource.createdAt, resource.status, resource.groupId, resource.supersededBy,
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

export function updateResourceStatus(db: Database.Database, id: string, status: ArtifactStatus, supersededBy?: string): void {
  const result = db.prepare(`
    UPDATE linked_resources
    SET status = ?, superseded_by = COALESCE(?, superseded_by)
    WHERE id = ? AND status != 'archived'
  `).run(status, supersededBy ?? null, id);

  if (result.changes === 0) {
    throw new Error(`LinkedResource ${id} not found or already archived`);
  }
}

export function supersedeLinkedResource(db: Database.Database, existingId: string, newResource: LinkedResource): void {
  db.exec("BEGIN");
  try {
    linkResource(db, newResource);

    const result = db.prepare(`
      UPDATE linked_resources
      SET status = 'superseded', superseded_by = ?
      WHERE id = ? AND status != 'archived'
    `).run(newResource.id, existingId);

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

/** F20260929czi0：进场游标写入。participant.lastReadSeq = 可选进场游标初值，缺省 0。
 *  两种进场场景语义（取代 F20260913ctlv test15 的「进场游标=0=读全部历史」口径——
 *  该口径把「未读」零点从进场点挪到对话起点，新獭天生背上全对话未读债，大对话 +
 *  小窗口模型首请求即爆窗；原始拍板追溯见 git 历史与 F20260929czi0）:
 *  - 新对话初始化（空对话）：缺省 0 天然正确——对话全部历史 = 开场白；
 *  - 加入已有对话（manage-participant.join）：传进场时刻 max(seq)——进场前历史
 *    不是未读，背景供给归派工简报/检索工具，不再按存在灌入。 */
export function createParticipant(db: Database.Database, participant: ConversationParticipant): void {
  db.prepare(`
    INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    participant.id, participant.conversationId, participant.otterId,
    participant.status, participant.createdAt, participant.lastReadSeq ?? 0,
  );
}

export function createParticipants(db: Database.Database, participants: ConversationParticipant[]): void {
  if (participants.length === 0) return;
  db.exec("BEGIN");
  try {
    // F20260929czi0：同 createParticipant——lastReadSeq 为可选进场游标初值（缺省 0）
    const stmt = db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of participants) {
      stmt.run(p.id, p.conversationId, p.otterId, p.status, p.createdAt, p.lastReadSeq ?? 0);
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
  leftAt: string,
): void {
  db.prepare(`
    UPDATE conversation_participants
    SET status = 'left', left_at = ?
    WHERE id = ?
  `).run(leftAt, participantId);
}

/** F20260902sgp2 S4c：游标 seq 双写（新刻度）。NULL 安全：last_read_seq 列可空，
 *  首次写入直接设值；回滚面 = 旧列 last_read_turn_number 未动，读路径按 NULL 回退。 */
/** #775：seq 刻度存量回填（一次性，停写旧列的前置）。以同会话最大 sequence_num 为
 *  基线回填 last_read_seq=NULL 的行——「读到最新」是双写过渡期 NULL 行的事实状态
 *  （这些行从未走过新路径，若回填 0 会把全部历史当未读，属 rbsg 形态误判）。
 *  幂等：只更新 NULL 行；回滚面 = 回填值与旧列独立，读路径 NULL 回退逻辑保留。
 *  F20260913ctlv 收尾批3：游标刻度切 entries（entries.sequence_num 是新时间线唯一序列；
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

/** F20260920trrt：对话内最大 sequence_num（闲置预警的全局刻度——turn 退役后唯一的「对话推进」度量） */
export function getMaxEntrySeq(db: Database.Database, conversationId: string): number {
  const row = db.prepare(`
    SELECT MAX(sequence_num) AS m FROM entries WHERE conversation_id = ?
  `).get(conversationId) as { m: number | null } | undefined;
  return row?.m ?? 0;
}

/** F20260920trrt：各 sender 的最后一条 speak（seq + created_at）——发言口径的活跃度。
 *  SQLite 裸列特性：GROUP BY + MAX() 时非聚合列取自 MAX 所在行（官方文档保证）。 */
export function getLastSpeakBySender(
  db: Database.Database,
  conversationId: string,
): Map<string, { seq: number; createdAt: string }> {
  const rows = db.prepare(`
    SELECT sender_id AS sid, MAX(sequence_num) AS seq, created_at AS ca
    FROM entries
    WHERE conversation_id = ? AND entry_type = 'speak' AND sender_type = 'otter'
    GROUP BY sender_id
  `).all(conversationId) as Array<{ sid: string | null; seq: number; ca: string }>;
  const map = new Map<string, { seq: number; createdAt: string }>();
  for (const r of rows) {
    if (r.sid) map.set(r.sid, { seq: r.seq, createdAt: r.ca });
  }
  return map;
}

/** F20260920trrt：各 otter 的最近一次被唤醒时间（invokes.started_at）——闲置预警时间护栏数据源 */
export function getLastInvokeStartedAtByOtter(
  db: Database.Database,
  conversationId: string,
): Map<string, string> {
  const rows = db.prepare(`
    SELECT otter_id AS oid, MAX(started_at) AS ma
    FROM invokes
    WHERE conversation_id = ?
    GROUP BY otter_id
  `).all(conversationId) as Array<{ oid: string | null; ma: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.oid && r.ma) map.set(r.oid, r.ma);
  }
  return map;
}


/** F20260803trrf: 指定 sender 的最新条目（F20260913ctlv 批3 切 entries；markBatchRead rejected 路径用）。
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
  id: string; conversation_id: string;
  sender_type: string | null; sender_id: string | null;
  entry_type: string; sequence_num: number; sender_name: string | null;
  created_at: string; completed_at: string | null; status: string;
  invoke_id: string | null; source: string | null;
};
function entryRowToMessageLike(row: EntryAsMessageRow & { body: string | null }): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
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

/** F20260929czi0：进场游标零点修正存量迁移（一次性，启动时调用）。
 *  active 参与者 × active 对话 × last_read_seq=0 → 该对话 max(seq)。
 *  Why：F20260913ctlv 的「进场游标=0」口径让零游标獭把全历史当未读；这些獭多为
 *  换世后首请求爆窗锁死（pushCursorOnStartup 只在启动成功时推进游标——爆窗 400 →
 *  不推进 → 永远全量未读，pi-session-factory.ts pushCursorOnStartup），从未成功消费
 *  过任何历史消息，事实状态就是「读到最新」，与 #775 backfillLastReadSeq 的回填
 *  语义同源。空对话里 max(seq)=0，迁移前后等价，幂等天然安全。
 *  幂等：只更新 0 行；全量推进后（游标恒 >0 或空对话仍为 0——后者重写等价零改动）
 *  重复执行零副作用。已知边界：空对话的零游标行迁移后仍为 0，守卫计数永不结清，
 *  每次启动会空转一次本 UPDATE（changes=0，零副作用）——为有历史对话的正确性
 *  付的固定微小成本，不优化。
 *  回滚语义：回滚本特性代码不会回滚本迁移（无备份列——0 本就是事故值，回滚到 0
 *  无意义且会复发爆窗；迁移值与旧列独立，无回滚需求。检视残留观察项，见特性文档）。 */
export function advanceZeroCursorsForActiveJoin(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE conversation_participants AS cp
    SET last_read_seq = (
      SELECT COALESCE(MAX(e.sequence_num), 0) FROM entries e WHERE e.conversation_id = cp.conversation_id
    )
    WHERE cp.status = 'active'
      AND cp.last_read_seq = 0
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = cp.conversation_id AND c.status = 'active')
  `).run();
  return result.changes;
}
