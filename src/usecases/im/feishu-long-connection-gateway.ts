export interface FeishuLongConnectionGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: FeishuLongConnectionMessage) => void): void;
}

/** F20260829fpst：飞书 post 富文本消息里的单个媒体段（img→image / media→file） */
export interface FeishuPostMediaItem {
  kind: "image" | "file";
  /** image 段为 image_key；file 段为 file_key */
  key: string;
  /** file 段携带的展示名（image 段无） */
  fileName?: string;
}

/** 多模态 Phase 2：飞书 image/file 消息的结构化载荷（frameworks 层解析后透传）。
 *  F20260829fpst：post 富文本混排消息以 type="post" 携带段落内媒体项列表 */
export interface FeishuMediaPayload {
  type: "image" | "file" | "post";
  /** image 消息的 image_key */
  imageKey?: string;
  /** file 消息的 file_key */
  fileKey?: string;
  /** file 消息的展示名（飞书推送携带） */
  fileName?: string;
  /** post 消息：按段落顺序的媒体项（纯文本 post 不带 media 载荷，走原文本路径） */
  postItems?: FeishuPostMediaItem[];
}

export interface FeishuLongConnectionMessage {
  chatId: string;
  messageId: string;
  text: string;
  senderId: string;
  senderType: string;
  messageType: string;
  /** 多模态 Phase 2：image/file 消息携带（text 消息无此字段） */
  media?: FeishuMediaPayload;
}
