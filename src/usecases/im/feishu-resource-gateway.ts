/**
 * 飞书资源下载网关端口（多模态 Phase 2：飞书 ingress 收图/收文件）。
 *
 * 飞书对 image/file 消息只推引用（image_key/file_key），不推字节——
 * 必须拿 message_id + key 回调下载 API 换字节流，再灌进统一附件管线。
 *
 * - image: GET /open-apis/im/v1/messages/{message_id}/resources/{image_key}?type=image
 * - file:  GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=file
 *   （file 需要独立权限 im:resource，权限缺失时降级为文本占位消息）
 *
 * 返回 null 语义：下载失败（权限未开/资源过期/网络错误）——调用方降级为
 * `[图片: 下载失败]` 文本占位，消息不丢（channel 提醒用户去 Web 端补传）。
 */
export interface FeishuResourceDownload {
  /** 资源字节（Buffer）+ 展示名（file 消息带 file_name；image 无名时给 image_key 短串） */
  buffer: Buffer;
  fileName: string;
}

export interface FeishuResourceGateway {
  /**
   * 下载消息资源。失败返回 null（不抛错——降级路径统一在调用方处理，避免错误处理散落）。
   */
  downloadMessageResource(
    messageId: string,
    resourceKey: string,
    type: "image" | "file",
  ): Promise<FeishuResourceDownload | null>;
}
