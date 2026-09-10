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
  getEntriesBefore(entryId: string, count: number): Promise<Entry[]>;
  getEntriesAfter(entryId: string, count: number): Promise<Entry[]>;
  getMaxSequenceNum(conversationId: string): Promise<number>;

  // FTS 搜索
  searchEntries(conversationId: string, query: string, limit?: number): Promise<Entry[]>;

  // 附件关联
  attachAttachment(entryId: string, attachmentId: string, sequenceNum?: number): Promise<void>;
  getAttachments(entryId: string): Promise<Array<{ attachmentId: string; sequenceNum: number }>>;

  // 恢复相关
  getInFlightEntries(conversationId: string): Promise<Entry[]>;
  failInFlightEntries(failedAt: string, noticeBody: string, skipEntryIds?: ReadonlySet<string>): Promise<number>;
}
