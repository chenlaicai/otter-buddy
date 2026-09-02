import type { Logger } from "@usecases/ports/logger";
import type { WeixinDownloadedMedia, WeixinMediaGateway, WeixinMediaGatewayItem } from "@usecases/im/weixin-media-gateway";
import type { WeixinCdnClient } from "./cdn/cdn-client";
import { WeixinItemType } from "./types";
import { silkToWav } from "./silk-transcode";

/**
 * 微信入站媒体下载实现（frameworks 层，issue #567 → #608 恢复四类全量）。
 *
 * 职责：协议 item → CDN 下载 + AES 解密（+ voice 的 silk→wav 转码）→
 * { fileName, mimeType, buffer }（交统一附件上传管线探嗅入库）。
 * key 优先级/编码细节来自 openclaw-weixin media/media-download.ts（MIT）审计。
 *
 * #567 期间曾收敛为仅图片（附件管线白名单不收音视频/pdf，检视发现 2）；
 * #608 扩展 sniffType（WAV/MP3/MP4/PDF magic bytes）后恢复 voice/file/video 分支。
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

  /** 语音：silk → wav（#608 恢复）；转码失败降级存原始 silk 字节（ASR 转写文本仍在消息体） */
  private async downloadVoice(voice: NonNullable<WeixinMediaGatewayItem["voice_item"]>): Promise<WeixinDownloadedMedia> {
    if (!voice.media?.aes_key) throw new Error("voice aes_key missing");
    const silkBuf = await this.deps.cdn.downloadAndDecrypt({
      encryptQueryParam: voice.media.encrypt_query_param,
      aesKeyBase64: voice.media.aes_key,
      fullUrl: voice.media.full_url,
    });
    const wav = await silkToWav(silkBuf);
    if (wav) return { fileName: `weixin-voice-${Date.now()}.wav`, mimeType: "audio/wav", buffer: wav };
    // 转码失败降级：原始 SILK 字节不在白名单（sniffType 拒），直接抛错走单项降级提示
    throw new Error("silk→wav 转码失败（原始 SILK 不在附件白名单）");
  }

  /** 视频：AES 解密直下（mp4 容器，#608 恢复） */
  private async downloadVideo(video: NonNullable<WeixinMediaGatewayItem["video_item"]>): Promise<WeixinDownloadedMedia> {
    if (!video.media?.aes_key) throw new Error("video aes_key missing");
    const buffer = await this.deps.cdn.downloadAndDecrypt({
      encryptQueryParam: video.media.encrypt_query_param,
      aesKeyBase64: video.media.aes_key,
      fullUrl: video.media.full_url,
    });
    return { fileName: `weixin-video-${Date.now()}.mp4`, mimeType: "video/mp4", buffer };
  }

  /** 文件：file_name 保留原始名，MIME 按后缀映射（octet-stream 交管线探嗅，#608 恢复） */
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
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = fileName.slice(dot).toLowerCase();
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
