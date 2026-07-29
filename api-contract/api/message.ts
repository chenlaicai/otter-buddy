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
