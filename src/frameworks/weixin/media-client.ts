import type { Logger } from "@usecases/ports/logger";
import type { WeixinDownloadedMedia, WeixinMediaGateway, WeixinMediaGatewayItem } from "@usecases/im/weixin-media-gateway";
import type { WeixinCdnClient } from "./cdn/cdn-client";
import { WeixinItemType } from "./types";

/**
 * 微信入站媒体下载实现（frameworks 层，issue #567）。
 *
 * 本期范围：仅图片入库（附件管线 MIME 白名单只收 image 四类 + 纯文本文档，
 * 音频/视频/pdf 会因 sniffType 返回 null 被拒——检视发现 2）。语音的转写
 * 文本已由 bodyFromItems 进消息体，体验不瞎；文件/视频降级为可见提示。
 * kind 白名单扩展（audio/video/pdf）独立 issue 跟踪后此处恢复对应分支。
 *
 * 图片 key 语义（openclaw-weixin media/media-download.ts 审计）：
 *   image_item.aeskey（hex 字符串）优先，media.aes_key（base64）兜底，
 *   均无时明文下载（部分缩略图场景）。
 */
export class WeixinMediaClient implements WeixinMediaGateway {
  constructor(
    private readonly deps: {
      cdn: WeixinCdnClient;
      logger: Logger;
    },
  ) {}

  async downloadMediaItem(item: WeixinMediaGatewayItem): Promise<WeixinDownloadedMedia> {
    if (item.type !== WeixinItemType.IMAGE || !item.image_item) {
      throw new Error(`unsupported media item type: ${item.type}（本期仅图片入库，见 issue #608）`);
    }
    const img = item.image_item;
    const aesKeyBase64 = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : img.media?.aes_key;
    const buffer = aesKeyBase64
      ? await this.deps.cdn.downloadAndDecrypt({ encryptQueryParam: img.media?.encrypt_query_param, aesKeyBase64, fullUrl: img.media?.full_url })
      : await this.deps.cdn.downloadPlain({ encryptQueryParam: img.media?.encrypt_query_param, fullUrl: img.media?.full_url });
    // 微信图片格式未知（jpg/png 混杂）：探嗅交给上传管线 magic bytes，声明名仅辅助
    return { fileName: `weixin-image-${Date.now()}.png`, mimeType: "image/png", buffer };
  }
}
