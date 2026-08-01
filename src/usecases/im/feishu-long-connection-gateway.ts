export interface FeishuLongConnectionGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: FeishuLongConnectionMessage) => void): void;
}

export interface FeishuLongConnectionMessage {
  chatId: string;
  messageId: string;
  text: string;
  senderId: string;
  senderType: string;
  messageType: string;
}
