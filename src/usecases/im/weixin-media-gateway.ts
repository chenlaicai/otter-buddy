/**
 * 微信入站媒体网关 port（issue #567）。
 *
 * 语义与 FeishuResourceGateway（usecases/im）对齐：interface-adapters 层的
 * processor 只依赖本 port；实现（CDN 下载 + AES 解密 + silk 转码）在
 * frameworks/weixin/media-client.ts。
 *
 * 入参 item 为协议 item 的结构化最小投影（结构兼容 WeixinMessageItem，
 * port 层不引 frameworks 类型）。
 */

/** 媒体 item 的最小结构投影（image/voice/file/video item 含 CDN 引用；兼容协议完整 item） */
export interface WeixinMediaGatewayItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: {
    aeskey?: string;
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
  };
  voice_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
  };
  file_item?: {
    file_name?: string;
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
  };
  video_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
  };
}

/** 下载解密产物（交附件上传管线） */
export interface WeixinDownloadedMedia {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface WeixinMediaGateway {
  /** 下载 + 解密单个媒体 item。voice 含 silk→wav 转码（失败降级原始字节） */
  downloadMediaItem(item: WeixinMediaGatewayItem): Promise<WeixinDownloadedMedia>;
}
