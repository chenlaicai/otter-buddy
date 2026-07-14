/**
 * SQLite 持久化：conversations + messages + conversation_otters + key_facts + linked_resources 表 CRUD。
 *
 * 使用 better-sqlite3 同步 API，外键约束已启用。
 * 消息存储为 append-only，禁止 UPDATE 和 DELETE（S3-A4 硬约束）。
 */

import type Database from "better-sqlite3";
import type {
  Attachment,
  Conversation,
  ConversationStatus,
  KeyFact,
  KeyFactInput,
  LinkedResource,
  LinkedResourceInput,
  Message,
  MessageEvent,
  MessageEventInput,
  MessageInput,
  MessageStatus,
  StartMessageInput,
} from "../model";
import {
  rowToConversation,
  rowToKeyFact,
  rowToLinkedResource,
  rowToMessage,
  rowToMessageEvent,
  type ConversationRow,
  type KeyFactRow,
  type LinkedResourceRow,
  type MessageEventRow,
  type MessageRow,
} from "./mapper";

export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  // --- Conversation CRUD ---

  /** 创建对话（root 或 child）。单事务内完成 conversations + conversation_otters 写入 */
  create(
    id: string,
    params: {
      title: string;
      parentId: string | null;
      treePath: string;
      otterIds: string[];
    },
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO conversations (id, title, status, parent_id, tree_path)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(id, params.title, params.parentId, params.treePath);

      const stmt = this.db.prepare(
        `INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)`,
      );
      for (const otterId of params.otterIds) {
        stmt.run(id, otterId);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getById(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  /** 更新对话状态：complete/archive 复用（S3-A2 设计） */
  updateStatus(id: string, status: ConversationStatus): void {
    if (status === "completed") {
      this.db
        .prepare(
          `UPDATE conversations
           SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(id);
    } else if (status === "archived") {
      this.db
        .prepare(
          `UPDATE conversations
           SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(id);
    }
  }

  getChildren(parentId: string): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE parent_id = ?")
      .all(parentId) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  // --- Tree ---

  getByTreePathPrefix(prefix: string): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE tree_path LIKE ?")
      .all(prefix) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  // --- Messages (two-layer model: body + streaming events) ---

  /** 创建已完成消息（用户消息）。从 DB 读取返回值确保 createdAt 一致 */
  createCompletedMessage(
    id: string,
    conversationId: string,
    message: MessageInput,
    sequenceNum: number,
  ): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, attachments, sequence_num)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        message.senderType,
        message.senderId,
        message.body,
        message.attachments ? JSON.stringify(message.attachments) : null,
        sequenceNum,
      );

    return this.getMessageById(id)!;
  }

  /** 创建 streaming 消息（Otter 消息开始） */
  createStreamingMessage(
    id: string,
    conversationId: string,
    sender: StartMessageInput,
    sequenceNum: number,
  ): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, body, attachments, sequence_num)
         VALUES (?, ?, 'otter', ?, 'streaming', NULL, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        sender.senderId,
        sender.attachments ? JSON.stringify(sender.attachments) : null,
        sequenceNum,
      );

    return this.getMessageById(id)!;
  }

  /** 完成消息：streaming -> completed（设置 body + completed_at） */
  completeMessage(
    messageId: string,
    body: string,
    attachments: Attachment[] | null,
  ): Message {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET status = 'completed', body = ?, attachments = ?, completed_at = datetime('now')
         WHERE id = ? AND status = 'streaming'`,
      )
      .run(
        body,
        attachments ? JSON.stringify(attachments) : null,
        messageId,
      );

    /** 检查 UPDATE 0 rows（并发保护，与 adapter 校验双重保障，架构师-2 #3） */
    if (result.changes === 0) {
      throw new Error(
        `Message ${messageId} not found or not in streaming status`,
      );
    }

    return this.getMessageById(messageId)!;
  }

  /** 失败消息：streaming -> failed（设置 completed_at，body 保持 NULL） */
  failMessage(messageId: string): Message {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET status = 'failed', completed_at = datetime('now')
         WHERE id = ? AND status = 'streaming'`,
      )
      .run(messageId);

    if (result.changes === 0) {
      throw new Error(
        `Message ${messageId} not found or not in streaming status`,
      );
    }

    return this.getMessageById(messageId)!;
  }

  getMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string; status?: MessageStatus },
  ): Message[] {
    const limit = opts?.limit ?? 50;
    const status = opts?.status;

    if (opts?.before) {
      let sql = `SELECT * FROM messages
         WHERE conversation_id = ?
           AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)`;
      const params: (string | number)[] = [conversationId, opts.before];
      if (status) {
        sql += ` AND status = ?`;
        params.push(status);
      }
      sql += ` ORDER BY sequence_num DESC LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as MessageRow[];
      return rows.map(rowToMessage);
    }

    let sql = `SELECT * FROM messages WHERE conversation_id = ?`;
    const params: (string | number)[] = [conversationId];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY sequence_num DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessageById(id: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMaxSequenceNum(conversationId: string): number {
    const result = this.db
      .prepare(
        "SELECT MAX(sequence_num) as max_seq FROM messages WHERE conversation_id = ?",
      )
      .get(conversationId) as { max_seq: number | null };
    return result.max_seq ?? 0;
  }

  // --- Message Events (append-only) ---

  appendEvent(
    id: string,
    messageId: string,
    event: MessageEventInput,
    sequenceNum: number,
  ): MessageEvent {
    this.db
      .prepare(
        `INSERT INTO message_events (id, message_id, event_type, payload, sequence_num)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        messageId,
        event.eventType,
        JSON.stringify(event.payload),
        sequenceNum,
      );

    const row = this.db
      .prepare("SELECT * FROM message_events WHERE id = ?")
      .get(id) as MessageEventRow;
    return rowToMessageEvent(row);
  }

  getMessageEvents(messageId: string): MessageEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM message_events WHERE message_id = ? ORDER BY sequence_num ASC",
      )
      .all(messageId) as MessageEventRow[];
    return rows.map(rowToMessageEvent);
  }

  getMaxEventSequenceNum(messageId: string): number {
    const result = this.db
      .prepare(
        "SELECT MAX(sequence_num) as max_seq FROM message_events WHERE message_id = ?",
      )
      .get(messageId) as { max_seq: number | null };
    return result.max_seq ?? 0;
  }

  // --- expandMessage ---

  getMessagesBefore(
    conversationId: string,
    messageId: string,
    count: number,
  ): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND sequence_num < (SELECT sequence_num FROM messages WHERE id = ?)
         ORDER BY sequence_num DESC
         LIMIT ?`,
      )
      .all(conversationId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessagesAfter(
    conversationId: string,
    messageId: string,
    count: number,
  ): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND sequence_num > (SELECT sequence_num FROM messages WHERE id = ?)
         ORDER BY sequence_num ASC
         LIMIT ?`,
      )
      .all(conversationId, messageId, count) as MessageRow[];
    return rows.map(rowToMessage);
  }

  // --- Key Info ---

  addKeyFact(
    id: string,
    conversationId: string,
    fact: KeyFactInput,
  ): KeyFact {
    this.db
      .prepare(
        `INSERT INTO key_facts (id, conversation_id, content, category, user_flagged, created_by, otter_id)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        fact.content,
        fact.category ?? null,
        fact.createdBy,
        fact.otterId ?? null,
      );

    const row = this.db
      .prepare("SELECT * FROM key_facts WHERE id = ?")
      .get(id) as KeyFactRow;
    return rowToKeyFact(row);
  }

  linkResource(
    id: string,
    conversationId: string,
    resource: LinkedResourceInput,
  ): LinkedResource {
    this.db
      .prepare(
        `INSERT INTO linked_resources (id, conversation_id, resource_type, url, title, metadata, linked_by, otter_id, auto_linked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        resource.resourceType,
        resource.url,
        resource.title ?? null,
        resource.metadata ? JSON.stringify(resource.metadata) : null,
        resource.linkedBy,
        resource.otterId ?? null,
        0,
      );

    const row = this.db
      .prepare("SELECT * FROM linked_resources WHERE id = ?")
      .get(id) as LinkedResourceRow;
    return rowToLinkedResource(row);
  }

  getKeyFacts(conversationId: string): KeyFact[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM key_facts WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId) as KeyFactRow[];
    return rows.map(rowToKeyFact);
  }

  getLinkedResources(conversationId: string): LinkedResource[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM linked_resources WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(conversationId) as LinkedResourceRow[];
    return rows.map(rowToLinkedResource);
  }

  // --- Otter Association ---

  getOtterIds(conversationId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT otter_id FROM conversation_otters WHERE conversation_id = ?",
      )
      .all(conversationId) as { otter_id: string }[];
    return rows.map((r) => r.otter_id);
  }

  // --- createChild (独立事务，S3-A2 + 架构师-2 G1/A1) ---

  /** 创建子对话：单事务内完成读 parent + 读 otterIds + INSERT child + INSERT conversation_otters + UPDATE parent.updated_at */
  createChild(parentId: string, childId: string, title: string): Conversation {
    this.db.exec("BEGIN");
    try {
      const parent = this.db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(parentId) as ConversationRow | undefined;
      if (!parent) {
        throw new Error(`Parent conversation ${parentId} not found`);
      }

      const otterRows = this.db
        .prepare(
          "SELECT otter_id FROM conversation_otters WHERE conversation_id = ?",
        )
        .all(parentId) as { otter_id: string }[];
      const otterIds = otterRows.map((r) => r.otter_id);

      const treePath = `${parent.tree_path}${childId}/`;

      this.db
        .prepare(
          `INSERT INTO conversations (id, title, status, parent_id, tree_path)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(childId, title, parentId, treePath);

      const stmt = this.db.prepare(
        "INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)",
      );
      for (const otterId of otterIds) {
        stmt.run(childId, otterId);
      }

      this.db
        .prepare(
          "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
        )
        .run(parentId);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getById(childId)!;
  }
}
