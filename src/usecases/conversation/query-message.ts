import type { Message, MessageEvent } from "@entities/conversation/message";
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

  async getMessageEvents(messageId: string): Promise<MessageEvent[]> {
    return this.repo.getMessageEvents(messageId);
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
      throw new Error(`Message not found: ${messageId}`);
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
}
