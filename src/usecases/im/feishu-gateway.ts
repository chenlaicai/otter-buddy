/**
 * 飞书消息网关接口（port）。
 *
 * - replyText: 纯文本消息,用于系统提示、降级、思考中临时消息
 * - replyMarkdown: 富文本消息(post + md),用于最终回复的 Markdown 渲染(F20260812fmdr)
 *   senderLabel 是跨信道的"发送者显示名"语义,不暴露飞书 post title 字段细节
 */
export interface FeishuGateway {
  replyText(chatId: string, text: string): Promise<void>;
  replyMarkdown(chatId: string, senderLabel: string, markdown: string): Promise<void>;
}
