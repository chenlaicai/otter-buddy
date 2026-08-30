import type { Logger } from "@usecases/ports/logger";
import type { WeixinGateway } from "@usecases/im/weixin-gateway";
// eslint-disable-next-line no-restricted-imports -- 依赖注入与飞书同构：接口定义在 usecases port（WeixinGateway），实现需要的协议类型从 frameworks 引入
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
// eslint-disable-next-line no-restricted-imports -- 同上：adapter 本就是 port 的 interface-adapters 实现，需要 account-store 的 context_token 回填
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";
// eslint-disable-next-line no-restricted-imports -- 同上：媒体出站需要 CDN 上传客户端与协议 item 类型
import type { WeixinCdnClient } from "@frameworks/weixin/cdn/cdn-client";
// eslint-disable-next-line no-restricted-imports -- 同上：出站 item 构建需要协议类型枚举（值导入，WeixinItemType 运行时用）
import { WeixinItemType } from "@frameworks/weixin/types";
// eslint-disable-next-line no-restricted-imports -- 同上：item 结构类型仅类型位置使用
import type { WeixinMessageItem } from "@frameworks/weixin/types";

/**
 * 微信出站网关（interface-adapters 层，实现 usecases 的 WeixinGateway port）。
 *
 * 出站需要 context_token（入站消息携带、有时效的服务端会话凭证）——从
 * AccountStore 的映射表回填；查不到时降级裸发（协议允许，微信侧表现为
 * 可能收不到，记 warn 提示需等用户先发消息）。
 */
export class WeixinGatewayAdapter implements WeixinGateway {
  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      accountStore: WeixinAccountStore;
      accountId: string;
      logger: Logger;
      /** CDN 上传客户端（issue #567 媒体出站；未注入时 replyMedia 抛不支持） */
      cdn?: WeixinCdnClient;
    },
  ) {}

  private resolveContextToken(toUserId: string): string | undefined {
    return this.deps.accountStore.loadContextTokens(this.deps.accountId)[toUserId];
  }

  async replyText(toUserId: string, text: string, options?: { requireContextToken?: boolean }): Promise<void> {
    const contextToken = this.resolveContextToken(toUserId);
    if (!contextToken) {
      if (options?.requireContextToken) {
        // F20260829wxch（#213 检视发现3）：thinking 提示消息竞态防护——
        // 首条消息 dispatch 落盘 context_token 前触发 message.start 时，
        // 裸发 context_token:undefined 会给微信侧协议带来未知行为，直接跳过
        // （thinking 是可丢失的体验优化，最终回复不受影响）
        this.deps.logger.info("Weixin thinking message skipped: no context_token yet (first-message race)", { toUserId });
        return;
      }
      this.deps.logger.warn("Weixin reply without context_token (对方需先发一条消息建立会话)", { toUserId });
    }
    await this.deps.api.sendTextMessage({ toUserId, contextToken, text });
  }

  /**
   * 微信协议仅支持纯文本（item type=1）。markdown 投影已在 usecases 层的
   * projectForChannel 完成（html-card → 占位符 + Web 链接），这里补一道
   * 轻量 markdown 语法降噪（去井号/星号/反引号等标记字符），保内容不保格式。
   * senderLabel 拼前缀（微信无私聊 bot 名展示位）。
   */
  async replyMarkdown(toUserId: string, senderLabel: string, markdown: string): Promise<void> {
    const text = `[${senderLabel}] ${WeixinGatewayAdapter.markdownToPlain(markdown)}`;
    await this.replyText(toUserId, text);
  }

  /** 媒体出站（issue #567）：读本地文件 → CDN 上传（AES-ECB）→ 按 MIME 路由 item 发送。
   *  平移自 openclaw-weixin send-media.ts 的路由语义：image/* → IMAGE，video/* → VIDEO，
   *  其余 → FILE。caption 非空时先发文本 item 再发媒体 item（逐 item 独立请求）。 */
  async replyMedia(toUserId: string, params: { filePath: string; fileName: string; mimeType: string; caption?: string }): Promise<void> {
    if (!this.deps.cdn) {
      throw new Error("WeixinGatewayAdapter.replyMedia: cdn client not injected");
    }
    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(params.filePath);

    const mediaType = params.mimeType.startsWith("video/") ? "VIDEO" : params.mimeType.startsWith("image/") ? "IMAGE" : "FILE";
    const uploaded = await this.deps.cdn.uploadFile({ buffer, toUserId, mediaType });

    // aes_key 协议格式：base64(hex 字符串)——与文件/语音/视频入站同编码（见 parseCdnAesKey）
    const media = {
      encrypt_query_param: uploaded.downloadParam,
      aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
      encrypt_type: 1,
    };
    let item: WeixinMessageItem;
    if (mediaType === "IMAGE") {
      item = { type: WeixinItemType.IMAGE, image_item: { media, mid_size: uploaded.fileSizeCiphertext } };
    } else if (mediaType === "VIDEO") {
      item = { type: WeixinItemType.VIDEO, video_item: { media, video_size: uploaded.fileSizeCiphertext } };
    } else {
      item = { type: WeixinItemType.FILE, file_item: { media, file_name: params.fileName, len: String(uploaded.fileSize) } };
    }

    const items: WeixinMessageItem[] = [];
    if (params.caption?.trim()) {
      items.push({ type: WeixinItemType.TEXT, text_item: { text: params.caption } });
    }
    items.push(item);

    const contextToken = this.resolveContextToken(toUserId);
    if (!contextToken) {
      this.deps.logger.warn("Weixin media reply without context_token (对方需先发一条消息建立会话)", { toUserId });
    }
    await this.deps.api.sendMessageItems({ toUserId, contextToken, items });
    this.deps.logger.info("Weixin media message sent", { toUserId, mediaType, filekey: uploaded.filekey });
  }

  /** markdown 语法字符降噪（标题/强调/代码/链接→文本）。尽力而为，不追求完美 */
  static markdownToPlain(md: string): string {
    return md
      // 链接 [text](url) → text（url 对纯文本用户是噪音）
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
      // 加粗/斜体
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // 行内代码与代码围栏标记
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^```[^\n]*$/gm, "")
      // 标题井号
      .replace(/^#{1,6}\s+/gm, "")
      // 引用块标记
      .replace(/^>\s?/gm, "")
      // 无序列表标记（保缩进层级感）
      .replace(/^(\s*)[-*]\s+/gm, "$1• ")
      // 连续空行压一行
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
