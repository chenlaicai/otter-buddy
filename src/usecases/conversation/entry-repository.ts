import type {
  Entry,
  EntryStatus,
  EntryType,
  SenderType,
} from "@entities/conversation/entry";

export interface GetEntriesOptions {
  limit?: number;
  before?: string;
  status?: EntryStatus;
  senderType?: SenderType;
  turnId?: string;
  entryType?: EntryType;
}

export interface EntryRepository {
  // Entry 生命周期
  createEntry(entry: Entry): Promise<void>;
  createEntries(entries: Entry[]): Promise<void>;
  /**
   * F20260910ctlv 彻底切换：原子序号插入——INSERT ... SELECT COALESCE(MAX(sequence_num),0)+1
   * 消灭「读 MAX 再写」竞态（多獭并发 invoke_start/speak 撞号 → UNIQUE 冲突丢条目）。
   * 入参 sequenceNum 被忽略，返回的 Entry 携带 DB 分配的真实序号。
   */
  createEntryAtomic(entry: Entry): Promise<Entry>;
  /** 原子序号批量插入（事务内逐条 MAX+1，天然连续递增）；返回携带真实序号的 Entry 列表 */
  createEntriesAtomic(entries: Entry[]): Promise<Entry[]>;
  updateEntryStatus(
    entryId: string,
    status: EntryStatus,
    completedAt?: string,
  ): Promise<void>;
  updateEntryBody(entryId: string, body: string): Promise<void>;
  updateEntryInvokeId(entryId: string, invokeId: string): Promise<void>;

  // Entry 查询
  getEntryById(id: string): Promise<Entry | null>;
  getEntries(
    conversationId: string,
    options?: GetEntriesOptions,
  ): Promise<Entry[]>;
  /** F20260910ctlv 彻底切换：按 turn 查 entries（turn 聚合目标/self-yield 护栏数据源） */
  getEntriesByTurnId(turnId: string, entryType?: EntryType): Promise<Entry[]>;
  getEntriesBefore(entryId: string, count: number): Promise<Entry[]>;
  getEntriesAfter(entryId: string, count: number): Promise<Entry[]>;
  getMaxSequenceNum(conversationId: string): Promise<number>;

  // FTS 搜索
  searchEntries(conversationId: string, query: string, limit?: number): Promise<Entry[]>;

  // 附件关联
  attachAttachment(entryId: string, attachmentId: string, sequenceNum?: number): Promise<void>;
  getAttachments(entryId: string): Promise<Array<{ attachmentId: string; sequenceNum: number }>>;

  /**
   * F20260910ctlv 彻底切换：獭未读注入数据源——entries 表（user/system/speak 按 sequenceNum）。
   * 游标口径与旧 messages.getUnreadMessages 一致（conversation_participants.last_read_seq），
   * 但 entries 与 messages 两套独立 seq 计数——游标列语义切到 entries 序号。
   */
  getUnreadEntries(conversationId: string, otterId: string): Promise<Entry[]>;

  // 恢复相关
  getInFlightEntries(conversationId: string): Promise<Entry[]>;
  failInFlightEntries(failedAt: string, noticeBody: string, skipEntryIds?: ReadonlySet<string>): Promise<number>;
}
