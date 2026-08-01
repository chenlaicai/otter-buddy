export interface FeishuGateway {
  replyText(chatId: string, text: string): Promise<void>;
}
