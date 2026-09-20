import type { ConversationRepository } from "./conversation-repository";
import type { EntryRepository } from "./entry-repository";

/** F20260913ctlv 批4c：QueryMessage 收缩——messages 表 drop 后仅剩未读状态一个活方法。
 *  F20260920trrt：getTurnsForTool 随 get_turn_history 工具退役删除（turns 表拆除）。
 *  其余 messages 表读取方法（getMessageById 与 getMessages、getMessageEvents 系列、searchMessages/
 *  expandMessage/findByExternalId/getTurnHistory 等）随旧表退役删除。 */
export class QueryMessage {
  constructor(
    private readonly repo: ConversationRepository,
    /** entries 数据源（未读状态计算用） */
    private readonly entryRepo?: EntryRepository,
  ) {}


  /** Web 用户未读状态（只读）：已读位置 + 未读计数 + 第一条未读条目。
   *  F20260913ctlv 彻底切换：未读状态读 entries（游标列复用，语义 = entries.sequence_num） */
  async getUnreadState(conversationId: string, userId: string): Promise<{
    lastReadSeq: number;
    unreadCount: number;
    firstUnreadMessageId: string | null;
    firstUnreadSeq: number | null;
  }> {
    if (!this.entryRepo) {
      return { lastReadSeq: 0, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null };
    }
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
}
