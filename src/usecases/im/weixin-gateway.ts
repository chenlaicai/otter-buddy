/**
 * 微信消息网关接口（port）。
 *
 * 出站语义与 FeishuGateway 对齐（issue #281 拆分后的通道约定）：
 * - replyText: 纯文本，用于系统提示、降级、“正在思考...”临时消息
 * - replyMarkdown: 最终回复。微信 ilink 协议不渲染 markdown 富文本——
 *   实现层做 markdown→纯文本投影后按文本发送（协议单一 item type=1）
 * - replyMedia: 媒体出站（issue #567）——本地文件经 CDN 上传后按
 *   image/file/video item 发送；文本在前媒体在后逐 item 独立请求
 */
export interface WeixinGateway {
  replyText(toUserId: string, text: string, options?: { requireContextToken?: boolean }): Promise<void>;
  replyMarkdown(toUserId: string, senderLabel: string, markdown: string): Promise<void>;
  /** 媒体出站：filePath 本地路径；mimeType 决定 item 路由（image/* → IMAGE，video/* → VIDEO，其余 FILE） */
  replyMedia(toUserId: string, params: { filePath: string; fileName: string; mimeType: string; caption?: string }): Promise<void>;
}
