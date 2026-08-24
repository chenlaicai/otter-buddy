/* eslint-disable max-lines -- conversation repo 含 message/turn/participant/read-state 等多域操作 */
import type Database from "better-sqlite3";
import type {
  ArtifactStatus,
  Conversation,
  ConversationParticipant,
  ConversationStatus,
  LinkedResource,
  Turn,
} from "@entities/conversation/conversation";
import type { Message, MessageEvent, MessageSegment } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";
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
  rowToSegment,
  rowToTurn,
  type ConversationRow,
  type MessageEventRow,
  type MessageRow,
  type SegmentRow,
  type TurnRow,
} from "./conversation-mapper";
import * as mixins from "./conversation-repository-mixins";

import { escapeFtsQuery } from "../fts-utils";

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * 应用层 FTS upsert（F20260728htar：废触发器后由 repository 接管）。
   * messages_fts.body 存 html-card 剥离投影。
   * 调用方必须在 db.transaction() 内使用（写消息 + FTS 同事务，中间崩溃不漂移）。
   */
  private upsertMessageFts(messageId: string, body: string): void {
    this.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId);
    this.db.prepare("INSERT INTO messages_fts (message_id, body) VALUES (?, ?)")
      .run(messageId, stripHtmlCardFences(body));
  }

  /** 从 segments 聚合 body 并刷新 FTS（调用方须在事务内） */
  private refreshMessageFts(messageId: string): void {
    const rows = this.db.prepare(
      "SELECT body FROM message_segments WHERE message_id = ? ORDER BY sequence_num ASC",
    ).all(messageId) as { body: string }[];
    const body = rows.map(r => r.body).join("\n\n");
    this.upsertMessageFts(messageId, body);
  }

  /** 批量加载 segments 并挂载到已映射的 messages */
  private attachSegments(messages: Message[]): void {
    if (messages.length === 0) return;
    const ids = messages.map(m => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM message_segments WHERE message_id IN (${placeholders}) ORDER BY sequence_num ASC`,
    ).all(...ids) as SegmentRow[];
    const byMsgId = new Map<string, MessageSegment[]>();
    for (const row of rows) {
      const seg = rowToSegment(row);
      const arr = byMsgId.get(seg.messageId) ?? [];
      arr.push(seg);
      byMsgId.set(seg.messageId, arr);
    }
    for (const msg of messages) {
      msg.segments = byMsgId.get(msg.id) ?? [];
    }
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

  async getMessagesByTurnId(turnId: string): Promise<Message[]> {
    const rows = this.db.prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence_num ASC")
      .all(turnId) as MessageRow[];
    const messages = rows.map(rowToMessage);
    this.attachSegments(messages);
    return messages;
  }

  // ── Message 生命周期 ──

  async createCompletedMessage(message: Message): Promise<void> {
    this.db.transaction(() => {
      const includeSource = message.source != null;
      const cols = includeSource
        ? `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, source, metadata, sender_name, created_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, metadata, sender_name, created_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params = [
        message.id, message.conversationId, message.senderType, message.senderId,
        message.sequenceNum, message.turnId,
        message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
        message.contextTokens, message.contextTokensMax,
        ...(includeSource ? [message.source] : []),
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.senderName ?? '',
        message.createdAt,
      ];
      this.db.prepare(cols).run(...params);
      // Insert segments if provided
      if (message.segments.length > 0) {
        const segStmt = this.db.prepare(
          "INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const seg of message.segments) {
          segStmt.run(seg.id, seg.messageId, seg.body, seg.sequenceNum, seg.createdAt);
        }
        this.refreshMessageFts(message.id);
      }
    })();
  }

  async createStreamingMessage(message: Message): Promise<void> {
    this.db.transaction(() => {
      const includeSource = message.source != null;
      const cols = includeSource
        ? `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, source, metadata, sender_name, created_at)
          VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status,
            sequence_num, turn_id, talking_stone_passed_to, context_tokens, context_tokens_max, metadata, sender_name, created_at)
          VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params = [
        message.id, message.conversationId, message.senderType, message.senderId,
        message.sequenceNum, message.turnId,
        message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
        message.contextTokens, message.contextTokensMax,
        ...(includeSource ? [message.source] : []),
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.senderName ?? '',
        message.createdAt,
      ];
      this.db.prepare(cols).run(...params);
      /** 无 segments 时 FTS 写空串 */
      this.upsertMessageFts(message.id, "");
    })();
  }

  async startSpeaking(messageId: string, body: string | undefined, talkingStonePassedTo: string[]): Promise<void> {
    this.db.transaction(() => {
      // 状态变更 + FTS 刷新同一事务；body 非空时附带插入 segment（speak+yield 拆分后 yield 调用不传 body）
      if (body !== undefined) {
        const maxSeq = this.db.prepare("SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM message_segments WHERE message_id = ?").get(messageId) as { max_seq: number };
        this.db.prepare("INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(`seg-${messageId}-${maxSeq.max_seq + 1}`, messageId, body, maxSeq.max_seq + 1);
      }
      const result = this.db.prepare(`
        UPDATE messages SET status = 'speaking', talking_stone_passed_to = ?
        WHERE id = ? AND status = 'streaming'
      `).run(JSON.stringify(talkingStonePassedTo), messageId);
      if (result.changes === 0) throw new DomainError(`Message ${messageId} not found or not in streaming status`, "conflict");
      this.refreshMessageFts(messageId);
    })();
  }

  async completeMessage(input: {
    messageId: string; talkingStonePassedTo: string[];
    completedAt: string;
    contextTokens?: number; contextTokensMax?: number;
  }): Promise<void> {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE messages SET status = 'completed', talking_stone_passed_to = ?,
          context_tokens = ?, context_tokens_max = ?, completed_at = ?
        WHERE id = ? AND status = 'speaking'
      `).run(
        JSON.stringify(input.talkingStonePassedTo),
        input.contextTokens ?? null, input.contextTokensMax ?? null,
        input.completedAt, input.messageId,
      );
      if (result.changes === 0) throw new DomainError(`Message ${input.messageId} not found or not in speaking status`, "conflict");
      this.refreshMessageFts(input.messageId);
    })();
  }

  async failMessage(messageId: string, failedAt: string, body?: string, talkingStonePassedTo?: string[]): Promise<void> {
    this.db.transaction(() => {
      // 插入 fail body segment（原子）
      if (body) {
        const maxSeq = this.db.prepare("SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM message_segments WHERE message_id = ?").get(messageId) as { max_seq: number };
        this.db.prepare("INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(`seg-${messageId}-fail-${maxSeq.max_seq + 1}`, messageId, body, maxSeq.max_seq + 1);
      }
      const updates: string[] = ["status = 'failed'", "completed_at = ?"];
      const params: unknown[] = [failedAt];
      if (talkingStonePassedTo !== undefined) { updates.push("talking_stone_passed_to = ?"); params.push(JSON.stringify(talkingStonePassedTo)); }
      params.push(messageId);
      const result = this.db.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE id = ? AND status IN ('streaming', 'speaking')`).run(...params);
      if (result.changes === 0) throw new DomainError(`Message ${messageId} not found or not in streaming/speaking status`, "conflict");
      if (body) this.refreshMessageFts(messageId);
    })();
  }

  async failInFlightMessages(failedAt: string, noticeBody: string): Promise<number> {
    /** streaming 无 segments 时插入中断说明 segment；speaking 已有 segments 则追加中断标记前缀。
     *  避免半截内容被其它 otter 当作完整发言读入上下文（F5）。 */
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM messages WHERE status IN ('streaming', 'speaking')",
      ).all() as { id: string }[];
      const update = this.db.prepare(`
        UPDATE messages SET status = 'failed', completed_at = ?
        WHERE id = ? AND status IN ('streaming', 'speaking')
      `);
      const segStmt = this.db.prepare(
        "INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const bumpSeq = this.db.prepare(
        "UPDATE message_segments SET sequence_num = sequence_num + 1 WHERE message_id = ?",
      );
      for (const row of rows) {
        // Insert notice as prefix (sequence_num=0): bump existing segments first
        bumpSeq.run(row.id);
        segStmt.run(crypto.randomUUID(), row.id, noticeBody, 0, failedAt);
        update.run(failedAt, row.id);
        this.refreshMessageFts(row.id);
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

  /**
   * 重置 failed 消息为 streaming（yield 重试专用）。
   * Why: SQL 层面做状态守卫（AND status = 'failed'），防止并发 abort 将终态消息重置回 streaming。
   * Why: 默认清空 segments 和 FTS 索引，避免重试期间搜索命中旧 fail 内容。
   * Why: preserveSegments=true 时保留 segments 并重建 FTS 索引（no_yield 重试专用：speak 内容有效，不应被删除）。
   */
  async resetForStreaming(messageId: string, turnId: string, preserveSegments: boolean = false): Promise<void> {
    this.db.transaction(() => {
      // F20260821fix: no_yield 重试时保留 segments（speak 内容有效，不应被删除）
      if (!preserveSegments) {
        this.db.prepare("DELETE FROM message_segments WHERE message_id = ?").run(messageId);
      }
      const result = this.db.prepare(`
        UPDATE messages
        SET status = 'streaming', turn_id = ?, completed_at = NULL,
            talking_stone_passed_to = NULL
        WHERE id = ? AND status = 'failed'
      `).run(turnId, messageId);
      if (result.changes === 0) {
        throw new DomainError(`resetForStreaming failed: message ${messageId} is not in failed status`, 'conflict');
      }
      if (!preserveSegments) {
        this.upsertMessageFts(messageId, '');
      } else {
        this.refreshMessageFts(messageId);
      }
    })();
  }

  async updateTokenUsage(messageId: string, contextTokens: number, contextTokensMax: number): Promise<void> {
    this.db.prepare(`UPDATE messages SET context_tokens = ?, context_tokens_max = ? WHERE id = ?`).run(
      contextTokens, contextTokensMax, messageId,
    );
  }

  async abortMessage(messageId: string, body: string, talkingStonePassedTo: string[], abortedAt: string): Promise<void> {
    this.db.transaction(() => {
      // 插入 abort body segment（原子，非空 body 才插入）
      if (body) {
        const maxSeq = this.db.prepare("SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM message_segments WHERE message_id = ?").get(messageId) as { max_seq: number };
        this.db.prepare("INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(`seg-${messageId}-abort-${maxSeq.max_seq + 1}`, messageId, body, maxSeq.max_seq + 1);
      }
      const result = this.db.prepare(`
        UPDATE messages SET status = 'aborted', talking_stone_passed_to = ?, completed_at = ?
        WHERE id = ? AND status IN ('streaming', 'speaking')
      `).run(JSON.stringify(talkingStonePassedTo), abortedAt, messageId);
      if (result.changes === 0) throw new DomainError(`Message ${messageId} not found or not in streaming/speaking status`, "conflict");
      if (body) this.refreshMessageFts(messageId);
    })();
  }

  async getMaxSequenceNum(conversationId: string): Promise<number> {
    const result = this.db.prepare("SELECT MAX(sequence_num) as max_seq FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { max_seq: number | null };
    return result.max_seq ?? 0;
  }

  // ── Message Segments ──

  async appendSegment(messageId: string, body: string): Promise<MessageSegment> {
    return this.db.transaction(() => {
      const maxSeq = this.db.prepare(
        "SELECT COALESCE(MAX(sequence_num), 0) AS max_seq FROM message_segments WHERE message_id = ?",
      ).get(messageId) as { max_seq: number };
      const seg: MessageSegment = {
        id: crypto.randomUUID(),
        messageId,
        body,
        sequenceNum: maxSeq.max_seq + 1,
        createdAt: new Date().toISOString(),
      };
      this.db.prepare(
        "INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(seg.id, seg.messageId, seg.body, seg.sequenceNum, seg.createdAt);
      this.refreshMessageFts(messageId);
      return seg;
    })();
  }

  async getSegments(messageId: string): Promise<MessageSegment[]> {
    const rows = this.db.prepare(
      "SELECT * FROM message_segments WHERE message_id = ? ORDER BY sequence_num ASC",
    ).all(messageId) as SegmentRow[];
    return rows.map(rowToSegment);
  }

  // ── Message 查询 ──

  async getMessageById(id: string): Promise<Message | null> {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) return null;
    const message = rowToMessage(row);
    this.attachSegments([message]);
    return message;
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
    const messages = rows.map(rowToMessage);
    this.attachSegments(messages);
    return messages;
  }

  async getMessagesBefore(messageId: string, count: number): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
        AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)
      ORDER BY sequence_num DESC LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    const messages = rows.map(rowToMessage);
    this.attachSegments(messages);
    return messages;
  }

  async getMessagesAfter(messageId: string, count: number): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
        AND sequence_num > (SELECT sequence_num FROM messages WHERE id = ?)
      ORDER BY sequence_num ASC LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    const messages = rows.map(rowToMessage);
    this.attachSegments(messages);
    return messages;
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
  async updateLastActiveTurnNumber(conversationId: string, otterId: string, turnNumber: number): Promise<void> { mixins.updateLastActiveTurnNumber(this.db, conversationId, otterId, turnNumber); }
  async markParticipantLeft(conversationId: string, otterId: string): Promise<void> { mixins.markParticipantLeft(this.db, conversationId, otterId); }
  async getUnreadMessages(conversationId: string, otterId: string): Promise<Message[]> {
    const messages = mixins.getUnreadMessages(this.db, conversationId, otterId).map(row => ({
      id: row.id, conversationId, senderType: row.sender_type as 'user' | 'otter' | 'system',
      senderId: row.sender_id, status: 'completed' as const, segments: [] as MessageSegment[],
      sequenceNum: row.sequence_num, turnId: '', talkingStonePassedTo: null,
      contextTokens: null, contextTokensMax: null, source: 'web' as const,
      senderName: '',
      createdAt: '', completedAt: null,
    }));
    this.attachSegments(messages);
    return messages;
  }

  async getLastMessageBySender(conversationId: string, senderId: string): Promise<Message | null> {
    const message = mixins.getLastMessageBySender(this.db, conversationId, senderId);
    if (!message) return null;
    this.attachSegments([message]);
    return message;
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
    if (!row) return null;
    const message = rowToMessage(row);
    this.attachSegments([message]);
    return message;
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
    if (!row) return null;
    const message = rowToMessage(row);
    this.attachSegments([message]);
    return message;
  }

  // eslint-disable-next-line max-lines-per-function -- F20260818segs segments 聚合逻辑增加行数
  async listConversationsWithMeta(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<Conversation & { otterIds: string[]; unreadCount: number; lastMessagePreview: string | null; lastMessageTs: string | null; activityStatus: 'processing' | 'awaiting_user' | 'idle' }>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT c.*,
        COALESCE(u.last_read_message_seq, 0) AS last_read_seq,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
          AND m.sequence_num > COALESCE(u.last_read_message_seq, 0)
          AND m.status NOT IN ('streaming', 'speaking')) AS unread_count,
        lm.id AS last_message_id,
        lm.created_at AS last_message_ts,
        (SELECT GROUP_CONCAT(otter_id, ',') FROM conversation_otters WHERE conversation_id = c.id) AS otter_ids_flat,
        CASE
          WHEN EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id AND status IN ('streaming', 'speaking'))
            THEN 'processing'
          WHEN EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.conversation_id = c.id
              AND m2.sender_type = 'otter'
              AND m2.talking_stone_passed_to IS NOT NULL
              AND m2.talking_stone_passed_to != '[]'
              AND m2.talking_stone_passed_to NOT LIKE '%user%'  -- 用户在目标列表中时应为 awaiting_user
              AND m2.talking_stone_passed_to LIKE '%otter%'
              AND m2.id = (
                SELECT id FROM messages WHERE conversation_id = c.id
                ORDER BY sequence_num DESC LIMIT 1
              )
          ) THEN 'processing'
          WHEN c.status = 'active' AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
            THEN 'awaiting_user'
          ELSE 'idle'
        END AS activity_status
      FROM conversations c
      LEFT JOIN conversation_user_read_state u ON u.conversation_id = c.id AND u.user_id = ?
      LEFT JOIN messages lm ON lm.id = (
        SELECT id FROM messages WHERE conversation_id = c.id AND status NOT IN ('streaming', 'speaking')
        ORDER BY sequence_num DESC LIMIT 1
      )
      WHERE c.status != 'archived'
      ORDER BY c.pinned DESC, COALESCE(lm.created_at, c.created_at) DESC LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as Array<ConversationRow & {
      last_read_seq: number; unread_count: number;
      last_message_id: string | null; last_message_ts: string | null;
      otter_ids_flat: string | null;
      activity_status: 'processing' | 'awaiting_user' | 'idle';
    }>;
    // Batch-load segments for all last messages
    const lastMsgIds = rows.map(r => r.last_message_id).filter((id): id is string => id != null);
    const segMap = new Map<string, string>();
    if (lastMsgIds.length > 0) {
      const placeholders = lastMsgIds.map(() => "?").join(",");
      const segRows = this.db.prepare(
        `SELECT message_id, body FROM message_segments WHERE message_id IN (${placeholders}) ORDER BY sequence_num ASC`,
      ).all(...lastMsgIds) as Array<{ message_id: string; body: string }>;
      for (const sr of segRows) {
        const prev = segMap.get(sr.message_id);
        segMap.set(sr.message_id, prev ? `${prev}\n\n${sr.body}` : sr.body);
      }
    }
    return rows.map(row => {
      const conv = rowToConversation(row);
      const aggregated = row.last_message_id ? (segMap.get(row.last_message_id) ?? "") : "";
      const preview = aggregated
        ? aggregated.replace(/<[^>]*>/g, "").slice(0, 50)
        : null;
      return {
        ...conv,
        otterIds: row.otter_ids_flat ? row.otter_ids_flat.split(",") : [],
        unreadCount: row.unread_count,
        lastMessagePreview: preview,
        lastMessageTs: row.last_message_ts,
        activityStatus: row.activity_status,
      };
    });
  }

  // ── Message 全文搜索（FTS5） ──

  async searchMessages(conversationId: string, query: string, limit = 10): Promise<Message[]> {
    const escaped = escapeFtsQuery(query);
    /** FTS 匹配后加载 segments（FTS body 是剥离投影，回看源码走 getMessageById）。 */
    const rows = this.db.prepare(`
      SELECT m.* FROM messages m
      INNER JOIN messages_fts fts ON fts.message_id = m.id
      WHERE m.conversation_id = ? AND messages_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(conversationId, escaped, limit) as MessageRow[];
    const messages = rows.map(rowToMessage);
    this.attachSegments(messages);
    return messages;
  }

  /** F20260805rbrg：按 metadata 查重。支持单条（externalId）和批量（externalIds 数组）两种格式。 */
  async findByExternalId(externalId: string): Promise<Message | null> {
    // 单条消息：externalId 字段精确匹配
    // 批量消息：externalIds JSON 数组中包含该值（用 JSON_EACH 展开）
    const row = this.db.prepare(`
      SELECT * FROM messages WHERE
        JSON_EXTRACT(metadata, '$.externalId') = ?
        OR EXISTS (SELECT 1 FROM JSON_EACH(JSON_EXTRACT(metadata, '$.externalIds')) WHERE value = ?)
      LIMIT 1
    `).get(externalId, externalId) as MessageRow | undefined;
    if (!row) return null;
    const message = rowToMessage(row);
    this.attachSegments([message]);
    return message;
  }

  // ── Turn 历史 ──

  async getTurnHistory(conversationId: string, includeMessages = false): Promise<TurnHistoryEntry[]> {
    const turnRows = this.db.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_number ASC")
      .all(conversationId) as TurnRow[];
    return turnRows.map(row => {
      const turn = rowToTurn(row);
      if (!includeMessages) return { turn, messages: [] };
      const messages = (this.db.prepare("SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence_num ASC")
        .all(turn.id) as MessageRow[]).map(rowToMessage);
      this.attachSegments(messages);
      return { turn, messages };
    });
  }
}
