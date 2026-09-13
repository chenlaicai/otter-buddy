/**
 * F20260913ctlv 彻底切换：Web 用户未读状态（entries 游标）。
 *
 * 切换语义：conversation_user_read_state.last_read_message_seq 列复用为 entries 序号游标
 * （列名不动——schema 不改，双写双读过渡由旧表数据自然沉淀）。
 * 未读数/首条未读按 entries 表统计（user/speak/system 条目）。
 */

import type { EntryRepository } from "./entry-repository";
import type { ConversationRepository } from "./conversation-repository";

export class ManageReadState {
  constructor(
    private readonly repo: ConversationRepository,
    /** F20260913ctlv：entries 数据源（未注入时降级旧 messages 语义——测试桩兼容） */
    private readonly entryRepo?: EntryRepository,
  ) {}

  /**
   * 标记已读到指定 entry sequenceNum。
   * upsertUserReadState 内部用 MAX(excluded, current)：只前进不后退。
   */
  async markRead(
    conversationId: string,
    userId: string,
    entrySeq: number,
  ): Promise<{ lastReadSeq: number; unreadCount: number }> {
    await this.repo.upsertUserReadState(conversationId, userId, entrySeq);
    const unreadCount = await this.getUnreadCount(conversationId, userId);
    return { lastReadSeq: entrySeq, unreadCount };
  }

  /** 未读 entries 数（user/speak/system；跳过自己 senderId=user） */
  async getUnreadCount(conversationId: string, userId: string): Promise<number> {
    if (!this.entryRepo) {
      return this.repo.getUnreadCount(conversationId, userId);
    }
    const state = await this.repo.getUserReadState(conversationId, userId);
    const lastReadSeq = state?.lastReadSeq ?? 0;
    const entries = await this.entryRepo.getEntries(conversationId, { limit: 200 });
    // getEntries DESC：数到 <= lastReadSeq 为止
    let count = 0;
    for (const e of entries) {
      if (e.sequenceNum <= lastReadSeq) break;
      if (e.entryType === "user") continue; // 自己的发言不算未读
      count++;
    }
    return count;
  }
}
