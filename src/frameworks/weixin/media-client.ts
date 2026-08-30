import type { Logger } from "@usecases/ports/logger";
import type { WeixinDownloadedMedia, WeixinMediaGateway, WeixinMediaGatewayItem } from "@usecases/im/weixin-media-gateway";
import type { WeixinCdnClient } from "./cdn/cdn-client";
import { WeixinItemType } from "./types";
import { silkToWav } from "./silk-transcode";

/**
 * 微信入站媒体下载实现（frameworks 层，issue #567）。
 *
 * 职责：协议 item → CDN 下载 + AES 解密（+ voice 的 silk→wav 转码）→
 * { fileName, mimeType, buffer }（交统一附件上传管线）。
 * key 优先级/编码细节来自 openclaw-weixin media/media-download.ts（MIT）审计。
 */
export class WeixinMediaClient implements WeixinMediaGateway {
  constructor(
    private readonly deps: {
      cdn: WeixinCdnClient;
      logger: Logger;
    },
  ) {}

  async downloadMediaItem(item: WeixinMediaGatewayItem): Promise<WeixinDownloadedMedia> {
    switch (item.type) {
      case WeixinItemType.IMAGE: return this.downloadImage(item.image_item!);
      case WeixinItemType.VOICE: return this.downloadVoice(item.voice_item!);
      case WeixinItemType.VIDEO: return this.downloadVideo(item.video_item!);
      case WeixinItemType.FILE: return this.downloadFile(item.file_item!);
      default: throw new Error(`unsupported media item type: ${item.type}`);
    }
  }

  /** 图片：key 优先 image_item.aeskey（hex→base64），无 key 时明文下载 */
  private async downloadImage(img: NonNullable<WeixinMediaGatewayItem["image_item"]>): Promise<WeixinDownloadedMedia> {
    const aesKeyBase64 = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : img.media?.aes_key;
    const buffer = aesKeyBase64
      ? await this.deps.cdn.downloadAndDecrypt({ encryptQueryParam: img.media?.encrypt_query_param, aesKeyBase64, fullUrl: img.media?.full_url })
      : await this.deps.cdn.downloadPlain({ encryptQueryParam: img.media?.encrypt_query_param, fullUrl: img.media?.full_url });
    // 微信图片格式未知（jpg/png 混杂）：探嗅交给上传管线 magic bytes，声明名仅辅助
    return { fileName: `weixin-image-${Date.now()}.png`, mimeType: "image/png", buffer };
  }

  /** 语音：silk → wav；转码失败降级存原始 silk（文本转写仍可用） */
  private async downloadVoice(voice: NonNullable<WeixinMediaGatewayItem["voice_item"]>): Promise<WeixinDownloadedMedia> {
    if (!voice.media?.aes_key) throw new Error("voice aes_key missing");
    const silkBuf = await this.deps.cdn.downloadAndDecrypt({
      encryptQueryParam: voice.media.encrypt_query_param,
      aesKeyBase64: voice.media.aes_key,
      fullUrl: voice.media.full_url,
    });
    const wav = await silkToWav(silkBuf);
    return wav
      ? { fileName: `weixin-voice-${Date.now()}.wav`, mimeType: "audio/wav", buffer: wav }
      : { fileName: `weixin-voice-${Date.now()}.silk`, mimeType: "application/octet-stream", buffer: silkBuf };
  }

  private async downloadVideo(video: NonNullable<WeixinMediaGatewayItem["video_item"]>): Promise<WeixinDownloadedMedia> {
    if (!video.media?.aes_key) throw new Error("video aes_key missing");
    const buffer = await this.deps.cdn.downloadAndDecrypt({
      encryptQueryParam: video.media.encrypt_query_param,
      aesKeyBase64: video.media.aes_key,
      fullUrl: video.media.full_url,
    });
    return { fileName: `weixin-video-${Date.now()}.mp4`, mimeType: "video/mp4", buffer };
  }

  /** 文件：file_name 保留原始名，MIME 按后缀映射（octet-stream 交管线探嗅） */
  private async downloadFile(file: NonNullable<WeixinMediaGatewayItem["file_item"]>): Promise<WeixinDownloadedMedia> {
    if (!file.media?.aes_key) throw new Error("file aes_key missing");
    const buffer = await this.deps.cdn.downloadAndDecrypt({
      encryptQueryParam: file.media.encrypt_query_param,
      aesKeyBase64: file.media.aes_key,
      fullUrl: file.media.full_url,
    });
    const fileName = file.file_name || `weixin-file-${Date.now()}.bin`;
    return { fileName, mimeType: mimeFromFileName(fileName), buffer };
  }
}

/** 文件名后缀 → MIME（常见类型；与 openclaw-weixin media/mime.ts 对齐的子集） */
export function mimeFromFileName(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  const table: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain", ".csv": "text/csv",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  };
  return table[ext] ?? "application/octet-stream";
}
