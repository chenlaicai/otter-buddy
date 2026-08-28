export interface FeishuLongConnectionGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: FeishuLongConnectionMessage) => void): void;
}

/** 多模态 Phase 2：飞书 image/file 消息的结构化载荷（frameworks 层解析后透传） */
export interface FeishuMediaPayload {
  type: "image" | "file";
  /** image 消息的 image_key */
  imageKey?: string;
  /** file 消息的 file_key */
  fileKey?: string;
  /** file 消息的展示名（飞书推送携带） */
  fileName?: string;
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
