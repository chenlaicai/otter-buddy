/**
 * F20260913ctlv: Entry DTO（时间线历史数据源）
 * 对应后端 Entry 实体（src/entities/conversation/entry.ts）
 */

export type EntryTypeDTO = "speak" | "user" | "invoke_start" | "invoke_end" | "yield" | "system";
export type EntryStatusDTO = "streaming" | "speaking" | "completed" | "failed" | "aborted";

/** 附件引用 DTO（多模态 Phase 1；终审修复：entry 读出链透出，与 MessageDTO.atts 同形） */
export interface EntryAttachmentDTO {
  id: string;
  kind: "image" | "document" | "audio" | "video";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

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
  status: EntryStatusDTO;
  source: "web" | "feishu" | "weixin" | null;
  metadata: Record<string, unknown> | null;
  senderName: string;
  /** F20260921otcl：发送者出生色（色板 key；仅 otter 条目携带，大獭/未回填为 null。
   *  查询时 join otters 一次取得，前端 resolveOtterVisual 消费） */
  senderColor: string | null;
  /** F20261021sprx：发送者类型（读时 join otters）；名册缺失时优先于前端 small 回退。 */
  senderOtterType?: 'big' | 'small';
  contextTokens: number | null;
  contextTokensMax: number | null;
  createdAt: string;
  completedAt: string | null;
  /** 附件引用（仅 speak/user 条目；非空时携带——entry_attachments JOIN 投影） */
  attachments?: EntryAttachmentDTO[];
  /** F20261013csv3 T5：过程明细开关（?includeEvents=true 时携带）——折叠后的工具调用
   *  步（foldInvokeEvents 同源投影），error 摘要 ≤200 字符，每 invoke ≤20 条。
   *  开销注意：开关打开时 N+1 变批量（invoke_events 表按 invokeId IN 一次取回），
   *  默认 false（关闭态读端点语义不变，零额外查询）。 */
  events?: FoldedStepDTO[];
}

/** T5：折叠后的工具调用步 DTO（foldInvokeEvents 投影——call/think/speak/error/user 五形） */
export type FoldedStepDTO =
  | { kind: "call"; name: string; args?: unknown; result?: unknown; isError?: boolean; pending: boolean; interrupted?: boolean; ts: string; tsEnd?: string }
  | { kind: "think"; text: string; ts: string }
  | { kind: "speak"; body: string; ts: string }
  | { kind: "error"; message: string; ts: string }
  | { kind: "user"; text: string; ts: string };

/** GET /api/conversations/:id/entries 响应 */
export interface EntriesResponseDTO {
  entries: EntryDTO[];
  hasMore: boolean;
}
