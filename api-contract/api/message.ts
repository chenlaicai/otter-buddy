/** 消息响应 DTO（前端短字段名映射，D57） */
export interface MessageDTO {
  id: string;
  st: string;
  si: string;
  content: string | null;
  status: string;
  ts: string;
  dur: string | null;
  seq: number;
  tsp: string[] | null;
  turnId: string;
  /** 发送者显示名（otter 消息为 otter 名；user/system 省略） */
  sn?: string;
  ctx?: number;
  ctxMax?: number;
  /** 消息来源 "web" | "feishu"，仅非 web 时携带 */
  src?: string;
  events?: MessageEventDTO[];
}

/** 消息事件 DTO */
export interface MessageEventDTO {
  id: string;
  messageId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sequenceNum: number;
  createdAt: string;
}

/** 发送消息请求 DTO */
export interface SendMessageRequestDTO {
  senderId: string;
  /** 发言石目标（@ 指定的 otter）。缺省或空数组表示未指定，由后端按默认规则解析（回复最后发言者，兜底大獭） */
  talkingStonePassedTo?: string[];
  body: string;
}

/** 消息列表响应（包裹对象，含 hasMore 分页标识） */
export interface MessageListResponseDTO {
  messages: MessageDTO[];
  hasMore: boolean;
}

/** 消息搜索结果 DTO（精简字段，不含 events/dur/ctx） */
export interface MessageSearchResultDTO {
  id: string;
  seq: number;
  content: string;
  st: string;
  sn?: string;
  ts: string;
  turnId: string;
}

/** 未读状态 DTO */
export interface UnreadStateDTO {
  lastReadSeq: number;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  firstUnreadSeq: number | null;
}

/** 标记已读响应 DTO */
export interface MarkReadResponseDTO {
  lastReadSeq: number;
  unreadCount: number;
}

/** 标记已读请求 DTO */
export interface MarkReadRequestDTO {
  messageSeq: number;
}
