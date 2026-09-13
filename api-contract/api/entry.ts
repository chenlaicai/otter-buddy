/**
 * F20260913ctlv: Entry DTO（时间线历史数据源）
 * 对应后端 Entry 实体（src/entities/conversation/entry.ts）
 */

export type EntryTypeDTO = "speak" | "user" | "invoke_start" | "invoke_end" | "yield" | "system";
export type EntryStatusDTO = "streaming" | "speaking" | "completed" | "failed" | "aborted";

/** 时间线条目 DTO */
export interface EntryDTO {
  id: string;
  conversationId: string;
  sequenceNum: number;
  entryType: EntryTypeDTO;
  senderType: "user" | "otter" | "system" | null;
  senderId: string | null;
  body: string | null;
  invokeId: string | null;
  yieldTargets: string[] | null;
  turnId: string;
  status: EntryStatusDTO;
  source: "web" | "feishu" | "weixin" | null;
  metadata: Record<string, unknown> | null;
  senderName: string;
  contextTokens: number | null;
  contextTokensMax: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** GET /api/conversations/:id/entries 响应 */
export interface EntriesResponseDTO {
  entries: EntryDTO[];
  hasMore: boolean;
}
