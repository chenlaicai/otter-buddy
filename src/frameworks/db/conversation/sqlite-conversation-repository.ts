import type Database from "better-sqlite3";
import type {
  Attachment,
  Conversation,
  ConversationParticipant,
  ConversationStatus,
  KeyFact,
  LinkedResource,
  Turn,
} from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";
import type {
  ConversationRepository,
  GetMessagesOptions,
} from "@usecases/conversation/conversation-repository";
import {
  rowToConversation,
  rowToKeyFact,
  rowToLinkedResource,
  rowToMessage,
  rowToMessageEvent,
  rowToParticipant,
  rowToTurn,
  type ConversationRow,
  type KeyFactRow,
  type LinkedResourceRow,
  type MessageEventRow,
  type MessageRow,
  type ParticipantRow,
  type TurnRow,
} from "./conversation-mapper";

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Conversation CRUD ──

  async create(conversation: Conversation, otterIds?: string[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO conversations (id, title, status, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        conversation.id,
        conversation.title,
        conversation.status,
        conversation.summary,
        conversation.createdAt,
        conversation.updatedAt,
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
      this.db.prepare(`
        UPDATE conversations SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, id);
    } else if (status === "archived") {
      this.db.prepare(`
        UPDATE conversations SET status = 'archived', archived_at = ?, updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, id);
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

  // ── Participants (static association) ──

  async getOtterIds(conversationId: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT otter_id FROM conversation_otters WHERE conversation_id = ?",
    ).all(conversationId) as { otter_id: string }[];
    return rows.map(r => r.otter_id);
  }

  // ── Turn 管理 ──

  async createTurn(turn: Turn): Promise<void> {
    this.db.prepare(`
      INSERT INTO turns (id, conversation_id, turn_number, status, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(turn.id, turn.conversationId, turn.turnNumber, turn.status, turn.createdAt);
  }

  async getActiveTurn(conversationId: string): Promise<Turn | null> {
    const row = this.db.prepare(`
      SELECT * FROM turns WHERE conversation_id = ? AND status = 'open' LIMIT 1
    `).get(conversationId) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  async closeTurn(turnId: string, closedAt: string): Promise<void> {
    this.db.prepare(`
      UPDATE turns SET status = 'closed', closed_at = ? WHERE id = ?
    `).run(closedAt, turnId);
  }

  async getMaxTurnNumber(conversationId: string): Promise<number> {
    const result = this.db.prepare(
      "SELECT MAX(turn_number) as max_num FROM turns WHERE conversation_id = ?",
    ).get(conversationId) as { max_num: number | null };
    return result.max_num ?? 0;
  }

  async getMessagesByTurnId(turnId: string): Promise<Message[]> {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE turn_id = ? ORDER BY sequence_num ASC",
    ).all(turnId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  // ── Message 生命周期 ──

  async createCompletedMessage(message: Message): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
        attachments, sequence_num, turn_id, talking_stone_passed_to, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.conversationId,
      message.senderType,
      message.senderId,
      message.body,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.sequenceNum,
      message.turnId,
      message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
      message.createdAt,
    );
  }

  async createStreamingMessage(message: Message): Promise<void> {
    this.db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body,
        attachments, sequence_num, turn_id, talking_stone_passed_to, created_at)
      VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.conversationId,
      message.senderType,
      message.senderId,
      message.body,
      message.attachments ? JSON.stringify(message.attachments) : null,
      message.sequenceNum,
      message.turnId,
      message.talkingStonePassedTo ? JSON.stringify(message.talkingStonePassedTo) : null,
      message.createdAt,
    );
  }

  async completeMessage(
    messageId: string,
    body: string,
    talkingStonePassedTo: string[],
    attachments: Attachment[] | null,
    completedAt: string,
  ): Promise<void> {
    const result = this.db.prepare(`
      UPDATE messages
      SET status = 'completed', body = ?, talking_stone_passed_to = ?, attachments = ?, completed_at = ?
      WHERE id = ? AND status = 'streaming'
    `).run(
      body,
      JSON.stringify(talkingStonePassedTo),
      attachments ? JSON.stringify(attachments) : null,
      completedAt,
      messageId,
    );

    if (result.changes === 0) {
      throw new Error(`Message ${messageId} not found or not in streaming status`);
    }
  }

  async failMessage(messageId: string, failedAt: string): Promise<void> {
    const result = this.db.prepare(`
      UPDATE messages SET status = 'failed', completed_at = ?
      WHERE id = ? AND status = 'streaming'
    `).run(failedAt, messageId);

    if (result.changes === 0) {
      throw new Error(`Message ${messageId} not found or not in streaming status`);
    }
  }

  async getMaxSequenceNum(conversationId: string): Promise<number> {
    const result = this.db.prepare(
      "SELECT MAX(sequence_num) as max_seq FROM messages WHERE conversation_id = ?",
    ).get(conversationId) as { max_seq: number | null };
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

    if (options.before) {
      sql += " AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)";
      params.push(options.before);
    }
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options.turnId) {
      sql += " AND turn_id = ?";
      params.push(options.turnId);
    }

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
      ORDER BY sequence_num DESC
      LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  async getMessagesAfter(messageId: string, count: number): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?)
        AND sequence_num > (SELECT sequence_num FROM messages WHERE id = ?)
      ORDER BY sequence_num ASC
      LIMIT ?
    `).all(messageId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  // ── MessageEvent ──

  async appendEvent(event: MessageEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO message_events (id, message_id, event_type, payload, sequence_num, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.messageId,
      event.eventType,
      JSON.stringify(event.payload),
      event.sequenceNum,
      event.createdAt,
    );
  }

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    const rows = this.db.prepare(
      "SELECT * FROM message_events WHERE message_id = ? ORDER BY sequence_num ASC",
    ).all(messageId) as MessageEventRow[];
    return rows.map(rowToMessageEvent);
  }

  async getMaxEventSequenceNum(messageId: string): Promise<number> {
    const result = this.db.prepare(
      "SELECT MAX(sequence_num) as max_seq FROM message_events WHERE message_id = ?",
    ).get(messageId) as { max_seq: number | null };
    return result.max_seq ?? 0;
  }

  // ── Key Info ──

  async addKeyFact(keyFact: KeyFact): Promise<void> {
    this.db.prepare(`
      INSERT INTO key_facts (id, conversation_id, content, category, user_flagged, created_by, otter_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      keyFact.id,
      keyFact.conversationId,
      keyFact.content,
      keyFact.category,
      keyFact.userFlagged ? 1 : 0,
      keyFact.createdBy,
      keyFact.otterId,
      keyFact.createdAt,
    );
  }

  async linkResource(resource: LinkedResource): Promise<void> {
    this.db.prepare(`
      INSERT INTO linked_resources (id, conversation_id, resource_type, url, title, metadata, linked_by, otter_id, auto_linked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resource.id,
      resource.conversationId,
      resource.resourceType,
      resource.url,
      resource.title,
      resource.metadata ? JSON.stringify(resource.metadata) : null,
      resource.linkedBy,
      resource.otterId,
      resource.autoLinked ? 1 : 0,
      resource.createdAt,
    );
  }

  async getKeyFacts(conversationId: string): Promise<KeyFact[]> {
    const rows = this.db.prepare(
      "SELECT * FROM key_facts WHERE conversation_id = ? ORDER BY created_at ASC",
    ).all(conversationId) as KeyFactRow[];
    return rows.map(rowToKeyFact);
  }

  async getLinkedResources(conversationId: string): Promise<LinkedResource[]> {
    const rows = this.db.prepare(
      "SELECT * FROM linked_resources WHERE conversation_id = ? ORDER BY created_at ASC",
    ).all(conversationId) as LinkedResourceRow[];
    return rows.map(rowToLinkedResource);
  }

  // ── Participant 管理 ──

  async createParticipant(participant: ConversationParticipant): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
        joined_at_turn_number, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      participant.id,
      participant.conversationId,
      participant.otterId,
      participant.joinedAtTurnId,
      participant.joinedAtTurnNumber,
      participant.status,
      participant.createdAt,
    );
  }

  async createParticipants(participants: ConversationParticipant[]): Promise<void> {
    if (participants.length === 0) return;
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id,
          joined_at_turn_number, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of participants) {
        stmt.run(p.id, p.conversationId, p.otterId, p.joinedAtTurnId, p.joinedAtTurnNumber, p.status, p.createdAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getParticipant(conversationId: string, otterId: string): Promise<ConversationParticipant | null> {
    const row = this.db.prepare(`
      SELECT * FROM conversation_participants WHERE conversation_id = ? AND otter_id = ? LIMIT 1
    `).get(conversationId, otterId) as ParticipantRow | undefined;
    return row ? rowToParticipant(row) : null;
  }

  async getActiveParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_participants WHERE conversation_id = ? AND status = 'active'
    `).all(conversationId) as ParticipantRow[];
    return rows.map(rowToParticipant);
  }

  async updateParticipantLeave(
    participantId: string,
    leftAtTurnId: string,
    leftAtTurnNumber: number,
    leftAt: string,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE conversation_participants
      SET status = 'left', left_at_turn_id = ?, left_at_turn_number = ?, left_at = ?
      WHERE id = ?
    `).run(leftAtTurnId, leftAtTurnNumber, leftAt, participantId);
  }
}
