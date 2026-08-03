import type { ConversationRepository } from "./conversation-repository";

/**
 * Web 用户已读状态管理（写操作，CQRS 与只读的 QueryMessage 分离）。
 * 单用户预留多用户：userId 当前固定 "web-user"，多用户扩展时按 user 隔离。
 */
export class ManageReadState {
  constructor(private readonly repo: ConversationRepository) {}

  /**
   * 标记已读到指定 messageSeq。
   * upsertUserReadState 内部用 MAX(excluded, current)：只前进不后退，
   * 用户向上回看旧消息不会降低已读位置。
   */
  async markRead(
    conversationId: string,
    userId: string,
    messageSeq: number,
  ): Promise<{ lastReadSeq: number; unreadCount: number }> {
    await this.repo.upsertUserReadState(conversationId, userId, messageSeq);
    const unreadCount = await this.repo.getUnreadCount(conversationId, userId);
    return { lastReadSeq: messageSeq, unreadCount };
  }
}
