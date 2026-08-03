import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  Conversation,
  ConversationParticipant,
  ConversationStatus,
  LinkedResource,
  Turn,
} from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";
import { stripHtmlCardFences } from "@entities/conversation/message-body-projection";
import type {
  ConversationRepository,
  GetMessagesOptions,
  TurnHistoryEntry,
} from "@usecases/conversation/conversation-repository";
import {
  rowToConversation,
  rowToMessage,
  rowToMessageEvent,
  rowToTurn,
  type ConversationRow,
  type MessageEventRow,
  type MessageRow,
  type TurnRow,
} from "./conversation-mapper";
import * as mixins from "./conversation-repository-mixins";

import { escapeFtsQuery } from "../fts-utils";

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * 应用层 FTS upsert（F20260728htar：废触发器后由 repository 接管）。
   * messages_fts.body 存 html-card 剥离投影；messages.body 原文不动。
   * 调用方必须在 db.transaction() 内使用（写消息 + FTS 同事务，中间崩溃不漂移）。
   */
  private upsertMessageFts(messageId: string, body: string): void {
    this.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId);
    this.db.prepare("INSERT INTO messages_fts (message_id, body) VALUES (?, ?)")
      .run(messageId, stripHtmlCardFences(body));
  }

  // ── Conversation CRUD ──

  async create(conversation: Conversation, otterIds?: string[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO conversations (id, title, status, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        conversation.id, conversation.title, conversation.status,
        conversation.summary, conversation.createdAt, conversation.updatedAt,
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
      "SELECT id FROM conversations ORDER BY created_at DESC LIMIT ? OFFSET ?",
    ).all(limit, offset) as { id: string }[];
    return rows.map(r => r.id);
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

  async closeTurn(turnId: string, closedAt: string): Promise<void> {
    this.db.prepare(`UPDATE turns SET status = 'closed', closed_at = ? WHERE id = ?`).run(closedAt, turnId);
  }

  async getMaxTurnNumber(conversationId: string): Promise<number> {
    const result = this.db.prepare("SELECT MAX(turn_number) as max_num FROM turns WHERE conversation_id = ?")
      .get(conversationId) as { max_num: number | null };
    return result.max_num ?? 0;
  }

  async getMessagesByTurnId(turnId: string): Promise<Message[]> {
    const rows = this.db.prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence_num ASC")
      .all(turnId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  // ── Message 生命周期 ──

  async createCompletedMessage(message: Message): Promise<void> {
    this.db.transaction(() => {
      const includeSource = message.source != null;
      const cols = includeSource
        ? `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, source, created_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, created_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`;
      const params = [
        message.id, message.conversationId, message.senderType, message.senderId,
        message.body,
        message.sequenceNum, message.turnId,
        message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
        message.contextTokens, message.contextTokensMax,
        ...(includeSource ? [message.source] : []),
        message.createdAt,
      ];
      this.db.prepare(cols).run(...params);
      this.upsertMessageFts(message.id, message.body ?? "");
    })();
  }

  async createStreamingMessage(message: Message): Promise<void> {
    this.db.transaction(() => {
      const includeSource = message.source != null;
      const cols = includeSource
        ? `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, source, created_at)
          VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, created_at)
          VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, ?, ?)`;
      const params = [
        message.id, message.conversationId, message.senderType, message.senderId,
        message.body,
        message.sequenceNum, message.turnId,
        message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
        message.contextTokens, message.contextTokensMax,
        ...(includeSource ? [message.source] : []),
        message.createdAt,
      ];
      this.db.prepare(cols).run(...params);
      /** body=null 时 FTS 写空串（复制旧触发器 COALESCE(NEW.body, '') 语义） */
      this.upsertMessageFts(message.id, message.body ?? "");
    })();
  }

  async startSpeaking(messageId: string, body: string, talkingStonePassedTo: string[]): Promise<void> {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE messages SET status = 'speaking', body = ?, talking_stone_passed_to = ?
        WHERE id = ? AND status = 'streaming'
      `).run(body, JSON.stringify(talkingStonePassedTo), messageId);
      if (result.changes === 0) throw new Error(`Message ${messageId} not found or not in streaming status`);
      this.upsertMessageFts(messageId, body);
    })();
  }

  async completeMessage(input: {
    messageId: string; body: string; talkingStonePassedTo: string[];
    completedAt: string;
    contextTokens?: number; contextTokensMax?: number;
  }): Promise<void> {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE messages SET status = 'completed', body = ?, talking_stone_passed_to = ?,
          context_tokens = ?, context_tokens_max = ?, completed_at = ?
        WHERE id = ? AND status = 'speaking'
      `).run(
        input.body, JSON.stringify(input.talkingStonePassedTo),
        input.contextTokens ?? null, input.contextTokensMax ?? null,
        input.completedAt, input.messageId,
      );
      if (result.changes === 0) throw new Error(`Message ${input.messageId} not found or not in speaking status`);
      this.upsertMessageFts(input.messageId, input.body);
    })();
  }

  async failMessage(messageId: string, failedAt: string, body?: string, talkingStonePassedTo?: string[]): Promise<void> {
    this.db.transaction(() => {
      const updates: string[] = ["status = 'failed'", "completed_at = ?"];
      const params: unknown[] = [failedAt];
      if (body !== undefined) { updates.unshift("body = ?"); params.unshift(body); }
      if (talkingStonePassedTo !== undefined) { updates.push("talking_stone_passed_to = ?"); params.push(JSON.stringify(talkingStonePassedTo)); }
      params.push(messageId);
      const result = this.db.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE id = ? AND status IN ('streaming', 'speaking')`).run(...params);
      if (result.changes === 0) throw new Error(`Message ${messageId} not found or not in streaming/speaking status`);
      /** 仅本次写入了 body 才 upsert（body 未变时旧触发器也不点火） */
      if (body !== undefined) this.upsertMessageFts(messageId, body);
    })();
  }

  async failInFlightMessages(failedAt: string, body: string): Promise<number> {
    /** streaming（body 为 null）写入中断说明；speaking 保留已有 speak body 但加中断标记前缀，
     *  避免半截 body 被其它 otter 当作完整发言读入上下文（F5）。
     *  F20260728htar：批量 SQL 改"SELECT 受影响行 → JS 合成新 body → 逐行 UPDATE + FTS upsert"。 */
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id, body FROM messages WHERE status IN ('streaming', 'speaking')",
      ).all() as { id: string; body: string | null }[];
      const update = this.db.prepare(`
        UPDATE messages SET status = 'failed', body = ?, completed_at = ?
        WHERE id = ? AND status IN ('streaming', 'speaking')
      `);
      for (const row of rows) {
        const newBody = row.body === null ? body : `${body}\n\n${row.body}`;
        update.run(newBody, failedAt, row.id);
        this.upsertMessageFts(row.id, newBody);
      }
      return rows.length;
    })();
  }

  async closeOrphanedTurns(closedAt: string): Promise<number> {
    const result = this.db.prepare(`
      UPDATE turns SET status = 'closed', closed_at = ?
      WHERE status = 'open' AND id NOT IN (
        SELECT DISTINCT turn_id FROM messages WHERE status IN ('streaming', 'speaking')
      )
    `).run(closedAt);
    return result.changes;
  }

  async updateTokenUsage(messageId: string, contextTokens: number, contextTokensMax: number): Promise<void> {
    this.db.prepare(`UPDATE messages SET context_tokens = ?, context_tokens_max = ? WHERE id = ?`).run(
      contextTokens, contextTokensMax, messageId,
    );
  }

  async abortMessage(messageId: string, body: string, talkingStonePassedTo: string[], abortedAt: string): Promise<void> {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE messages SET status = 'aborted', body = ?, talking_stone_passed_to = ?, completed_at = ?
        WHERE id = ? AND status IN ('streaming', 'speaking')
      `).run(body, JSON.stringify(talkingStonePassedTo), abortedAt, messageId);
      if (result.changes === 0) throw new Error(`Message ${messageId} not found or not in streaming/speaking status`);
      this.upsertMessageFts(messageId, body);
    })();
  }

  async getMaxSequenceNum(conversationId: string): Promise<number> {
    const result = this.db.prepare("SELECT MAX(sequence_num) as max_seq FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { max_seq: number | null };
    return result.max_seq ?? 0;
  }

  // ── Message 查询 ──

  async getMessageById(id: string): Promise<Message | null> {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  async getMessages(conversationId: string, options: GetMessagesOptions): Promise<Message[]> {
    const limit = options.limit ?? 50;
    const params: (string | number)[] = [conversationId];
    let sql = "SELECT * FROM messages WHERE conversation_id = ?";
    if (options.before) { sql += " AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)"; params.push(options.before); }
    if (options.status) { sql += " AND status = ?"; params.push(options.status); }
    if (options.senderType) { sql += " AND sender_type = ?"; params.push(options.senderType); }
    if (options.turnId) { sql += " AND turn_id = ?"; params.push(options.turnId); }
    sql += " ORDER BY sequence_num DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async getMessagesBefore(messageId: string, count: number): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
        AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)
      ORDER BY sequence_num DESC LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async getMessagesAfter(messageId: string, count: number): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
        AND sequence_num > (SELECT sequence_num FROM messages WHERE id = ?)
      ORDER BY sequence_num ASC LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  // ── MessageEvent ──

  async appendEvent(event: MessageEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO message_events (id, message_id, event_type, payload, sequence_num, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.messageId, event.eventType, JSON.stringify(event.payload), event.sequenceNum, event.createdAt);
  }

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    const rows = this.db.prepare("SELECT * FROM message_events WHERE message_id = ? ORDER BY sequence_num ASC")
      .all(messageId) as MessageEventRow[];
    return rows.map(rowToMessageEvent);
  }

  async getMessageEventsByMessageIds(messageIds: string[]): Promise<MessageEvent[]> {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM message_events WHERE message_id IN (${placeholders}) ORDER BY sequence_num ASC`,
    ).all(...messageIds) as MessageEventRow[];
    return rows.map(rowToMessageEvent);
  }

  async getMaxEventSequenceNum(messageId: string): Promise<number> {
    const result = this.db.prepare("SELECT MAX(sequence_num) as max_seq FROM message_events WHERE message_id = ?")
      .get(messageId) as { max_seq: number | null };
    return result.max_seq ?? 0;
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
  async updateLastReadTurnNumber(conversationId: string, otterId: string, turnNumber: number): Promise<void> { mixins.updateLastReadTurnNumber(this.db, conversationId, otterId, turnNumber); }
  async getUnreadMessages(conversationId: string, otterId: string): Promise<Message[]> {
    const rows = mixins.getUnreadMessages(this.db, conversationId, otterId);
    return rows.map(row => ({
      id: row.id, conversationId, senderType: row.sender_type as 'user' | 'otter' | 'system',
      senderId: row.sender_id, status: 'completed' as const, body: row.body,
      sequenceNum: row.sequence_num, turnId: '',
      talkingStonePassedTo: null, contextTokens: null, contextTokensMax: null,
      source: 'web' as const,
      createdAt: '', completedAt: null,
    }));
  }

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

  async getFirstUnreadMessage(conversationId: string, userId: string): Promise<Message | null> {
    const row = this.db.prepare(`
      SELECT m.* FROM messages m
      WHERE m.conversation_id = ?
        AND m.sequence_num > COALESCE(
          (SELECT last_read_message_seq FROM conversation_user_read_state WHERE user_id = ? AND conversation_id = ?), 0
        )
        AND m.status NOT IN ('streaming', 'speaking')
      ORDER BY m.sequence_num ASC LIMIT 1
    `).get(conversationId, userId, conversationId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  async getUnreadCount(conversationId: string, userId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM messages
      WHERE conversation_id = ?
        AND sequence_num > COALESCE(
          (SELECT last_read_message_seq FROM conversation_user_read_state WHERE user_id = ? AND conversation_id = ?), 0
        )
        AND status NOT IN ('streaming', 'speaking')
    `).get(conversationId, userId, conversationId) as { cnt: number };
    return row.cnt;
  }

  async getLastMessage(conversationId: string): Promise<Message | null> {
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND status NOT IN ('streaming', 'speaking') ORDER BY sequence_num DESC LIMIT 1",
    ).get(conversationId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  async listConversationsWithMeta(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<Conversation & { otterIds: string[]; unreadCount: number; lastMessagePreview: string | null; lastMessageTs: string | null }>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT c.*,
        COALESCE(u.last_read_message_seq, 0) AS last_read_seq,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
          AND m.sequence_num > COALESCE(u.last_read_message_seq, 0)
          AND m.status NOT IN ('streaming', 'speaking')) AS unread_count,
        lm.body AS last_message_body,
        lm.created_at AS last_message_ts,
        (SELECT GROUP_CONCAT(otter_id, ',') FROM conversation_otters WHERE conversation_id = c.id) AS otter_ids_flat
      FROM conversations c
      LEFT JOIN conversation_user_read_state u ON u.conversation_id = c.id AND u.user_id = ?
      LEFT JOIN messages lm ON lm.id = (
        SELECT id FROM messages WHERE conversation_id = c.id AND status NOT IN ('streaming', 'speaking')
        ORDER BY sequence_num DESC LIMIT 1
      )
      WHERE c.status != 'archived'
      ORDER BY c.created_at DESC LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as Array<ConversationRow & {
      last_read_seq: number; unread_count: number;
      last_message_body: string | null; last_message_ts: string | null;
      otter_ids_flat: string | null;
    }>;
    return rows.map(row => {
      const conv = rowToConversation(row);
      const preview = row.last_message_body
        ? row.last_message_body.replace(/<[^>]*>/g, "").slice(0, 50)
        : null;
      return {
        ...conv,
        otterIds: row.otter_ids_flat ? row.otter_ids_flat.split(",") : [],
        unreadCount: row.unread_count,
        lastMessagePreview: preview,
        lastMessageTs: row.last_message_ts,
      };
    });
  }

  // ── Message 全文搜索（FTS5） ──

  async searchMessages(conversationId: string, query: string, limit = 10): Promise<Message[]> {
    const escaped = escapeFtsQuery(query);
    /** 返回 fts.body（剥离投影）而非 messages.body 原文——检索出口不含 HTML 卡片源码；
     *  消息其他字段仍取 m.*，body 用 fts.body 覆盖。回看源码走 getMessageById。 */
    const rows = this.db.prepare(`
      SELECT m.*, fts.body AS fts_body FROM messages m
      INNER JOIN messages_fts fts ON fts.message_id = m.id
      WHERE m.conversation_id = ? AND messages_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(conversationId, escaped, limit) as (MessageRow & { fts_body: string })[];
    return rows.map(row => ({ ...rowToMessage(row), body: row.fts_body }));
  }

  // ── Turn 历史 ──

  async getTurnHistory(conversationId: string, includeMessages = false): Promise<TurnHistoryEntry[]> {
    const turnRows = this.db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_number ASC")
      .all(conversationId) as TurnRow[];
    return turnRows.map(row => {
      const turn = rowToTurn(row);
      return {
        turn,
        messages: includeMessages
          ? (this.db.prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence_num ASC")
              .all(turn.id) as MessageRow[]).map(rowToMessage)
          : [],
      };
    });
  }
}
