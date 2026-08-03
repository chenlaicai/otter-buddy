import type { Message, MessageEvent } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";
import type { ConversationRepository, GetMessagesOptions, TurnHistoryEntry } from "./conversation-repository";

export class QueryMessage {
  constructor(private readonly repo: ConversationRepository) {}

  async getMessageById(id: string): Promise<Message | null> {
    return this.repo.getMessageById(id);
  }

  async getMessages(
    conversationId: string,
    options: GetMessagesOptions,
  ): Promise<Message[]> {
    return this.repo.getMessages(conversationId, options);
  }

  /** after 游标查询：比指定消息更新的消息（升序），用于向下分页 */
  async getMessagesAfter(messageId: string, count: number): Promise<Message[]> {
    return this.repo.getMessagesAfter(messageId, count);
  }

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    return this.repo.getMessageEvents(messageId);
  }

  async getMessageEventsByMessageIds(messageIds: string[]): Promise<MessageEvent[]> {
    return this.repo.getMessageEventsByMessageIds(messageIds);
  }

  /** 关键词搜索消息（FTS5 trigram） */
  async searchMessages(
    conversationId: string,
    query: string,
    limit?: number,
  ): Promise<Message[]> {
    return this.repo.searchMessages(conversationId, query, limit);
  }

  /** 获取 Turn 历史链（含消息） */
  async getTurnHistory(
    conversationId: string,
    opts?: { includeMessages?: boolean },
  ): Promise<TurnHistoryEntry[]> {
    return this.repo.getTurnHistory(conversationId, opts?.includeMessages);
  }

  async expandMessage(
    messageId: string,
    direction: "before" | "after" | "both",
    count: number,
  ): Promise<Message[]> {
    const target = await this.repo.getMessageById(messageId);
    if (!target) {
      throw new DomainError(`Message not found: ${messageId}`, "not_found");
    }

    if (direction === "before") {
      return this.repo.getMessagesBefore(messageId, count);
    }

    if (direction === "after") {
      return this.repo.getMessagesAfter(messageId, count);
    }

    /** both: 合并 before + target + after，按 sequenceNum 升序 */
    const before = await this.repo.getMessagesBefore(messageId, count);
    const after = await this.repo.getMessagesAfter(messageId, count);
    return [...before, target, ...after].sort((a, b) => a.sequenceNum - b.sequenceNum);
  }

  /** Web 用户未读状态（只读）：已读位置 + 未读计数 + 第一条未读消息 */
  async getUnreadState(conversationId: string, userId: string): Promise<{
    lastReadSeq: number;
    unreadCount: number;
    firstUnreadMessageId: string | null;
    firstUnreadSeq: number | null;
  }> {
    const state = await this.repo.getUserReadState(conversationId, userId);
    const lastReadSeq = state?.lastReadSeq ?? 0;
    const unreadCount = await this.repo.getUnreadCount(conversationId, userId);
    if (unreadCount === 0) {
      return { lastReadSeq, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null };
    }
    const firstUnread = await this.repo.getFirstUnreadMessage(conversationId, userId);
    return {
      lastReadSeq,
      unreadCount,
      firstUnreadMessageId: firstUnread?.id ?? null,
      firstUnreadSeq: firstUnread?.sequenceNum ?? null,
    };
  }
}
