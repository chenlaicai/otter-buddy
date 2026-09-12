import type { Message, MessageEvent } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";
import type { ConversationRepository, GetMessagesOptions, TurnHistoryEntry } from "./conversation-repository";
import type { EntryRepository } from "./entry-repository";

export class QueryMessage {
  constructor(
    private readonly repo: ConversationRepository,
    /** F20260910ctlv 彻底切换：entries 数据源（未注入时降级旧 messages 语义） */
    private readonly entryRepo?: EntryRepository,
  ) {}

  async getMessageById(id: string): Promise<Message | null> {
    return this.repo.getMessageById(id);
  }

  /** F20260826rsme：指定 senderType 的最新消息（恢复前并发窗口检查用） */
  async getLastMessageBySenderType(conversationId: string, senderType: "user" | "otter" | "system"): Promise<Message | null> {
    return this.repo.getLastMessageBySenderType(conversationId, senderType);
  }

  /** 指定 sender 在对话中的最新消息（markBatchRead rejected 路径用） */
  async getLastMessageBySender(conversationId: string, senderId: string): Promise<Message | null> {
    return this.repo.getLastMessageBySender(conversationId, senderId);
  }

  /** F20260910ctlv 批4a：turn 骨架（get_turn_history 工具用——turns 表保留，
   *  只取 turn 不带 messages；条目从 entries 按需取） */
  async getTurnsForTool(conversationId: string): Promise<Array<{ id: string; turnNumber: number; status: string; createdAt: string; closedAt: string | null }>> {
    const history = await this.repo.getTurnHistory(conversationId, false);
    return history.map(h => h.turn);
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

  /** F20260805rbrg：按 metadata.externalId 查重 */
  async findByExternalId(externalId: string): Promise<Message | null> {
    return this.repo.findByExternalId(externalId);
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
    // F20260910ctlv 彻底切换：未读状态读 entries（游标列复用，语义 = entries.sequence_num）
    if (this.entryRepo) {
      const state = await this.repo.getUserReadState(conversationId, userId);
      if (!state) {
        return { lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null };
      }
      const lastReadSeq = state.lastReadSeq;
      const entries = await this.entryRepo.getEntries(conversationId, { limit: 200 });
      // getEntries DESC：从最新往回找到第一条 <= lastReadSeq 的位置
      const newer = [] as typeof entries;
      for (const e of entries) {
        if (e.sequenceNum <= lastReadSeq) break;
        newer.push(e);
      }
      const unread = newer.filter(e => e.entryType !== "user").reverse();
      if (unread.length === 0) {
        return { lastReadSeq, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null };
      }
      const first = unread[0]!;
      return {
        lastReadSeq,
        unreadCount: unread.length,
        firstUnreadMessageId: first.id,
        firstUnreadSeq: first.sequenceNum,
      };
    }
    const state = await this.repo.getUserReadState(conversationId, userId);
    if (!state) {
      // 首次访问（无已读记录）：不视为全部未读，前端加载后初始化已读到最新
      return { lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null };
    }
    const lastReadSeq = state.lastReadSeq;
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
