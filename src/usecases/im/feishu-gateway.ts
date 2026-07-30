export interface FeishuGateway {
  replyText(chatId: string, text: string): Promise<void>;
  /** 验证飞书 Webhook 签名 */
  verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean;
}
