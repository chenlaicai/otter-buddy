import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  Conversation,
  ConversationParticipant,
  ConversationStatus,
  LinkedResource,
  Turn,
} from "@entities/conversation/conversation";
import type {
  ConversationRepository,
  TurnHistoryEntry,
} from "@usecases/conversation/conversation-repository";
import {
  rowToConversation,
  rowToTurn,
  type ConversationRow,
  type TurnRow,
} from "./conversation-mapper";
import * as mixins from "./conversation-repository-mixins";

import type { Logger } from "@usecases/ports/logger";

export class SqliteConversationRepository implements ConversationRepository {
  /** 多模态 Phase 1：附件 repo（消息组装点①——repository 加载回填 attachments） */
  /** 审视修复 R8：附件 JOIN 降级时留痕（不再吞错——真实 DB 故障须可观测） */
  private readonly logger?: Logger;

  constructor(
    private readonly db: Database.Database,
    logger?: Logger,
  ) {
    this.logger = logger;
  }



  // ── Conversation CRUD ──

  async create(conversation: Conversation, otterIds?: string[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO conversations (id, title, status, summary, pinned, workspace_dir, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversation.id, conversation.title, conversation.status,
        conversation.summary, conversation.pinned ? 1 : 0,
        conversation.workspaceDir,
        conversation.createdAt, conversation.updatedAt,
      );

      if (otterIds && otterIds.length > 0) {
        const stmt = this.db.prepare(
          "INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)",
        );
        for (const otterId of otterIds) {
          stmt.run(conversation.id, otterId);
        }
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getById(id: string): Promise<Conversation | null> {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  async updateStatus(id: string, status: ConversationStatus, timestamp: string): Promise<void> {
    if (status === "completed") {
      this.db.prepare(`UPDATE conversations SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, id);
    } else if (status === "archived") {
      this.db.prepare(`UPDATE conversations SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, id);
    } else {
      throw new Error(`Unsupported status transition: ${status}`);
    }
  }

  async getIdsByOtterId(otterId: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT conversation_id FROM conversation_otters WHERE otter_id = ?",
    ).all(otterId) as { conversation_id: string }[];
    return rows.map(r => r.conversation_id);
  }

  async getAllIds(options?: { limit?: number; offset?: number }): Promise<string[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(
      "SELECT id FROM conversations ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?",
    ).all(limit, offset) as { id: string }[];
    return rows.map(r => r.id);
  }

  async updatePinned(id: string, pinned: boolean): Promise<void> {
    this.db.prepare("UPDATE conversations SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  // ── Participants (static association) ──

  async getOtterIds(conversationId: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT otter_id FROM conversation_otters WHERE conversation_id = ?",
    ).all(conversationId) as { otter_id: string }[];
    return rows.map(r => r.otter_id);
  }

  // ── Turn 管理 ──

  async createTurn(turn: Turn): Promise<void> {
    this.db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, status, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(turn.id, turn.conversationId, turn.turnNumber, turn.status, turn.createdAt);
  }

  async getActiveTurn(conversationId: string): Promise<Turn | null> {
    const row = this.db.prepare(`SELECT * FROM turns WHERE conversation_id = ? AND status = 'open' LIMIT 1`)
      .get(conversationId) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  async getTurnById(turnId: string): Promise<Turn | null> { return mixins.getTurnById(this.db, turnId); }

  async closeTurn(turnId: string, closedAt: string): Promise<void> {
    this.db.prepare(`UPDATE turns SET status = 'closed', closed_at = ? WHERE id = ?`).run(closedAt, turnId);
  }

  async getMaxTurnNumber(conversationId: string): Promise<number> {
    const result = this.db.prepare("SELECT MAX(turn_number) as max_num FROM turns WHERE conversation_id = ?")
      .get(conversationId) as { max_num: number | null };
    return result.max_num ?? 0;
  }


  async closeOrphanedTurns(closedAt: string): Promise<number> {
    // F20260910ctlv 批4c：判据源切 invokes（messages 表已 drop——open = 该 turn 下有 running invoke；
    // turn 归属经 entries.turn_id 关联，invokes 表无 turn_id 列）
    const result = this.db.prepare(`
      UPDATE turns SET status = 'closed', closed_at = ?
      WHERE status = 'open' AND id NOT IN (
        SELECT DISTINCT e.turn_id FROM invokes i
        JOIN entries e ON e.invoke_id = i.id
        WHERE i.status = 'running'
      )
    `).run(closedAt);
    return result.changes;
  }


  // ── Key Resources（委托给 mixin） ──

  async linkResource(resource: LinkedResource): Promise<void> { mixins.linkResource(this.db, resource); }
  async getLinkedResources(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]> { return mixins.getLinkedResources(this.db, conversationId, filters); }
  async getLinkedResourceById(id: string): Promise<LinkedResource | null> { return mixins.getLinkedResourceById(this.db, id); }
  async getLinkedResourcesByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]> { return mixins.getLinkedResourcesByGroup(this.db, conversationId, groupId); }
  async updateResourceStatus(id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): Promise<void> { mixins.updateResourceStatus(this.db, id, status, statusChangedAtTurnNumber, supersededBy); }
  async supersedeLinkedResource(existingId: string, newResource: LinkedResource, statusChangedAtTurnNumber: number): Promise<void> { mixins.supersedeLinkedResource(this.db, existingId, newResource, statusChangedAtTurnNumber); }
  async deleteLinkedResource(id: string): Promise<void> { mixins.deleteLinkedResource(this.db, id); }
  async flagResource(id: string, flagged: boolean): Promise<void> { mixins.flagResource(this.db, id, flagged); }

  // ── Participant 管理（委托给 mixin） ──

  async createParticipant(participant: ConversationParticipant): Promise<void> { mixins.createParticipant(this.db, participant); }
  async createParticipants(participants: ConversationParticipant[]): Promise<void> { mixins.createParticipants(this.db, participants); }
  async getParticipant(conversationId: string, otterId: string): Promise<ConversationParticipant | null> { return mixins.getParticipant(this.db, conversationId, otterId); }
  async getActiveParticipants(conversationId: string): Promise<ConversationParticipant[]> { return mixins.getActiveParticipants(this.db, conversationId); }
  async updateParticipantLeave(participantId: string, leftAtTurnId: string, leftAtTurnNumber: number, leftAt: string): Promise<void> { mixins.updateParticipantLeave(this.db, participantId, leftAtTurnId, leftAtTurnNumber, leftAt); }
  async updateLastReadSeq(conversationId: string, otterId: string, seq: number): Promise<void> { mixins.updateLastReadSeq(this.db, conversationId, otterId, seq); }
  /** #775：seq 刻度存量回填（一次性，启动时调用） */
  backfillLastReadSeq(): number { return mixins.backfillLastReadSeq(this.db); }
  async updateLastReadTurnNumber(conversationId: string, otterId: string, turnNumber: number): Promise<void> { mixins.updateLastReadTurnNumber(this.db, conversationId, otterId, turnNumber); }
  async updateLastActiveTurnNumber(conversationId: string, otterId: string, turnNumber: number): Promise<void> { mixins.updateLastActiveTurnNumber(this.db, conversationId, otterId, turnNumber); }
  async markParticipantLeft(conversationId: string, otterId: string): Promise<void> { mixins.markParticipantLeft(this.db, conversationId, otterId); }

  // ── Web 用户已读状态（消息级，与 otter 的 turn 级独立） ──

  async getUserReadState(conversationId: string, userId: string): Promise<{ lastReadSeq: number } | null> {
    const row = this.db.prepare(
      "SELECT last_read_message_seq FROM conversation_user_read_state WHERE user_id = ? AND conversation_id = ?",
    ).get(userId, conversationId) as { last_read_message_seq: number } | undefined;
    return row ? { lastReadSeq: row.last_read_message_seq } : null;
  }

  async upsertUserReadState(conversationId: string, userId: string, lastReadSeq: number): Promise<void> {
    /** ON CONFLICT 用 MAX：只前进不后退（用户向上回看旧消息不应降低已读位置） */
    this.db.prepare(`
      INSERT INTO conversation_user_read_state (user_id, conversation_id, last_read_message_seq, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, conversation_id) DO UPDATE SET
        last_read_message_seq = MAX(excluded.last_read_message_seq, last_read_message_seq),
        updated_at = datetime('now')
    `).run(userId, conversationId, lastReadSeq);
  }

  async getUnreadCount(conversationId: string, userId: string): Promise<number> {
    // F20260910ctlv 批4c：数据源切 entries（messages 表 drop）——跳过用户自己的气泡
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM entries
      WHERE conversation_id = ?
        AND sequence_num > COALESCE(
          (SELECT last_read_message_seq FROM conversation_user_read_state WHERE user_id = ? AND conversation_id = ?), 0
        )
        AND entry_type IN ('speak', 'system')
    `).get(conversationId, userId, conversationId) as { cnt: number };
    return row.cnt;
  }


  async listConversationsWithMeta(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<Conversation & { otterIds: string[]; unreadCount: number; lastMessagePreview: string | null; lastMessageTs: string | null; activityStatus: 'processing' | 'awaiting_user' | 'idle' }>> {
    // F20260910ctlv 批4c：数据源切 entries（messages 表 drop）——
    // unread/activity/last 预览全部从时间线读取；activity 判据 = running invoke（invokes 表）
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT c.*,
        COALESCE(u.last_read_message_seq, 0) AS last_read_seq,
        (SELECT COUNT(*) FROM entries e WHERE e.conversation_id = c.id
          AND e.sequence_num > COALESCE(u.last_read_message_seq, 0)
          AND e.entry_type IN ('speak', 'system')) AS unread_count,
        le.id AS last_entry_id,
        le.created_at AS last_entry_ts,
        le.body AS last_entry_body,
        (SELECT GROUP_CONCAT(otter_id, ',') FROM conversation_otters WHERE conversation_id = c.id) AS otter_ids_flat,
        CASE
          WHEN EXISTS (SELECT 1 FROM invokes WHERE conversation_id = c.id AND status = 'running')
            THEN 'processing'
          WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM entries WHERE conversation_id = c.id)
            THEN 'awaiting_user'
          ELSE 'idle'
        END AS activity_status
      FROM conversations c
      LEFT JOIN conversation_user_read_state u ON u.conversation_id = c.id AND u.user_id = ?
      LEFT JOIN entries le ON le.id = (
        SELECT id FROM entries WHERE conversation_id = c.id
          AND entry_type IN ('user', 'speak', 'system')
        ORDER BY sequence_num DESC LIMIT 1
      )
      WHERE c.status != 'archived'
      ORDER BY c.pinned DESC, COALESCE(le.created_at, c.created_at) DESC LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as Array<ConversationRow & {
      last_read_seq: number; unread_count: number;
      last_entry_id: string | null; last_entry_ts: string | null; last_entry_body: string | null;
      otter_ids_flat: string | null;
      activity_status: 'processing' | 'awaiting_user' | 'idle';
    }>;
    return rows.map(row => {
      const conv = rowToConversation(row);
      const preview = row.last_entry_body
        ? (row.last_entry_body as string).replace(/<[^>]*>/g, "").slice(0, 50)
        : null;
      return {
        ...conv,
        otterIds: row.otter_ids_flat ? row.otter_ids_flat.split(",") : [],
        unreadCount: row.unread_count,
        lastMessagePreview: preview,
        lastMessageTs: row.last_entry_ts,
        activityStatus: row.activity_status,
      };
    });
  }

  // ── Message 全文搜索（FTS5） ──

  /** F20260805rbrg：按 metadata 查重。支持单条（externalId）和批量（externalIds 数组）两种格式。 */

  /** F20260909smsp：按 invokeGroupId 查询 invoke 消息链（首个 message + speak messages） */
  // ── Turn 历史 ──

  async getTurnHistory(conversationId: string): Promise<TurnHistoryEntry[]> {
    // F20260910ctlv 批4c：messages 表 drop——只返回 turns 骨架，entries 由调用方经 EntryRepository.getEntriesByTurnId 装配
    const turnRows = this.db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_number ASC")
      .all(conversationId) as TurnRow[];
    return turnRows.map(rowToTurn).map(turn => ({ turn }));
  }
}
