/**
 * 微信消息网关接口（port）。
 *
 * 出站语义与 FeishuGateway 对齐（issue #281 拆分后的通道约定）：
 * - replyText: 纯文本，用于系统提示、降级、"正在思考..."临时消息
 * - replyMarkdown: 最终回复。微信 ilink 协议不渲染 markdown 富文本——
 *   实现层做 markdown→纯文本投影后按文本发送（协议单一 item type=1）
 */
export interface WeixinGateway {
  replyText(toUserId: string, text: string, options?: { requireContextToken?: boolean }): Promise<void>;
  replyMarkdown(toUserId: string, senderLabel: string, markdown: string): Promise<void>;
}
