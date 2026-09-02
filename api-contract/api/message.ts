/** 消息分段 DTO */
export interface MessageSegmentDTO {
  id: string;
  body: string;
  sequenceNum: number;
}

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
  /** 信号档位（F20260902u5tr：yield 投石为 NORMAL/URGENT/HALT，用户消息无列值隐式 NORMAL）；仅非空时携带 */
  lvl?: string;
  /** 发送者显示名（otter 消息为 otter 名；user/system 省略） */
  sn?: string;
  ctx?: number;
  ctxMax?: number;
  /** 消息来源 "web" | "feishu"，仅非 web 时携带 */
  src?: string;
  /** 消息分段数组（多 speak 气泡），仅 agent 消息且 segments 非空时携带 */
  segments?: MessageSegmentDTO[];
  /** 消息关联的獭间信号（F20260826mwrd C4）——徽章在消息原位渲染，仅 otter 消息且有关联信号时携带 */
  signals?: MessageSignalDTO[];
  /** 多模态 Phase 1：消息携带的附件（仅 attachments 非空时携带） */
  atts?: AttachmentDTO[];
  events?: MessageEventDTO[];
}

/** 信号轨迹单项（F20260902u5tr：一次投石对一个 otter 目标的投递状态）。
 *  state 判据（服务端持久层推导，前端零推导；F20260902sgp2 S1b 判据切台账）：
 *  - PENDING：dispatch_attempts 无该 (message, target) 记录（排队=还没派发）
 *  - CONSUMING：attempt 行 in_progress（持久行，无 5min 墙钟窗，无状态倒退）
 *  - CONSUMED：attempt 终态 completed
 *  - FAILED：attempt 终态 failed/aborted（❌ + note，失败可见 → 用户决定是否 retry） */
export interface SignalTrailItemDTO {
  messageId: string;
  fromType: "user" | "otter";
  fromId: string;
  targetOtterId: string;
  /** 档位（signal_level 列解析，NULL 归一为 NORMAL——与 SignalRouter 判据一致） */
  level: "NORMAL" | "URGENT" | "HALT" | string;
  state: "PENDING" | "CONSUMING" | "CONSUMED" | "FAILED";
  ts: string;
  seq: number;
  /** FAILED 态展示失败原因（attempt.note，含 retry 前情压缩——§8.2 折中）；其余态 null */
  note?: string | null;
}

export interface SignalTrailResponseDTO {
  items: SignalTrailItemDTO[];
}

/** 消息关联的獭间信号（F20260826mwrd C4：UI 徽章数据源） */
export interface MessageSignalDTO {
  id: string;
  type: "objection" | "blocked" | "halt";
  severity: "low" | "medium" | "high";
  /** 实体状态机三态（halt 落账即 resolved，resolvedBy=system——见 signal-event.ts 状态说明） */
  status: "pending" | "resolved" | "dismissed";
  /** 信号正文（事实依据/已试清单/halt 理由），前端点击展开用 */
  payload: string;
  /** 发起獭 ID（UI 展示发起者，可映射名字） */
  fromOtterId: string;
  /** halt 目标獭（type=halt 时携带） */
  targetOtterId?: string | null;
  /** 裁决文本（resolved/dismissed 后携带，徽章显示摘要） */
  resolution?: string | null;
  resolvedBy?: string | null;
  createdAt: string;
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

/** 附件 DTO（多模态 Phase 1，消息携带的附件透出；#608 扩 kind 值域 audio/video） */
export interface AttachmentDTO {
  id: string;
  kind: "image" | "document" | "audio" | "video";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

/** 上传响应 DTO（多模态 Phase 1） */
export interface UploadAttachmentResponseDTO {
  attachments: AttachmentDTO[];
}

/** 发送消息请求 DTO */
export interface SendMessageRequestDTO {
  senderId: string;
  /** 发言石目标（@ 指定的 otter）。缺省或空数组表示未指定，由后端按默认规则解析（回复最后发言者，兜底大獭） */
  talkingStonePassedTo?: string[];
  body: string;
  /** 多模态 Phase 1：随消息引用的附件 ID（上传 API 先返回；可选，向后兼容） */
  attachmentIds?: string[];
}

/** 消息列表响应（包裹对象，含 hasMore 分页标识） */
export interface MessageListResponseDTO {
  messages: MessageDTO[];
  hasMore: boolean;
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
