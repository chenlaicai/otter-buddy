import type { Logger } from "@usecases/ports/logger";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";
import type { FeishuConfig } from "./types";

import { botKey as deriveBotKey } from "./bot-key";

export type { FeishuConfig };

const FEISHU_MESSAGES_ENDPOINT = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";

/** 降级前缀:post + md 发送失败时,转 replyText 用纯文本兜底,标记体感落差 */
const DEGRADE_PREFIX = "[纯文本降级]\n\n";

/** #902：图片上传端点（飞书 im/v1/images，multipart/form-data） */
const FEISHU_IMAGE_UPLOAD_ENDPOINT = "https://open.feishu.cn/open-apis/im/v1/images";

export class FeishuClient implements FeishuGateway {
  /** F20260920imax 增量五：bot 身份键（掩码 appId）——按 bot 锚定路由的键源 */
  readonly botKey: string;

  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
    private readonly tokenManager: FeishuAccessTokenManager,
  ) {
    // F20260928fsqr（检视建议③）：入站路由锚改单源派生（与 provision/出站同走 bot-key.ts）
    this.botKey = deriveBotKey(this.config.appId);
  }

  /** 发送文本消息到群 */
  async replyText(chatId: string, text: string): Promise<void> {
    const token = await this.tokenManager.getAccessToken();

    const response = await fetch(FEISHU_MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    const data = (await response.json()) as {
      code: number;
      msg: string;
    };

    if (data.code !== 0) {
      this.logger.error("Failed to send Feishu message", undefined, {
        chatId,
        code: data.code,
        msg: data.msg,
      });
      throw new Error(`Failed to send message: ${data.msg}`);
    }

    this.logger.info("Feishu message sent", { chatId, textLength: text.length });
  }

  /**
   * 发送 Markdown 富文本消息(post + md 标签,F20260812fmdr)。
   *
   * post JSON 结构:
   *   { zh_cn: { title: "[senderLabel]", content: [[{ tag: "md", text: markdown }]] } }
   *
   * md 标签支持 CommonMark 0.31 + GFM 子集(标题/加粗/斜体/删除线/代码块/表格/链接等)。
   * 失败时降级到 replyText,带 `[纯文本降级]` 前缀,保证消息必达且体感落差可识别。
   */
  async replyMarkdown(chatId: string, senderLabel: string, markdown: string): Promise<void> {
    const content = JSON.stringify({
      zh_cn: {
        title: `[${senderLabel}]`,
        content: [[{ tag: "md", text: markdown }]],
      },
    });

    try {
      const token = await this.tokenManager.getAccessToken();
      const response = await fetch(FEISHU_MESSAGES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "post",
          content,
        }),
      });

      const data = (await response.json()) as { code: number; msg: string };
      if (data.code !== 0) {
        throw new Error(`Feishu post+md rejected: code=${data.code} msg=${data.msg}`);
      }

      this.logger.info("Feishu markdown message sent", {
        chatId,
        senderLabel,
        markdownLength: markdown.length,
      });
    } catch (err) {
      this.logger.warn("Feishu replyMarkdown failed, degrading to replyText", {
        chatId,
        senderLabel,
        error: err instanceof Error ? err.message : String(err),
      });
      // 降级:必达优先,带前缀让用户感知到格式异常
      await this.replyText(chatId, `${DEGRADE_PREFIX}${markdown}`);
    }
  }

  /** #902 媒体出站：图片真实投递。读本地文件 → FormData 上传（im/v1/images，
   *  image_type=message）拿 image_key → 发 msg_type=image 消息。
   *  失败抛错由调用方降级（占位投影已在文本里可见，不阻塞）；
   *  image_key 格式校验：飞书正常返回非空字符串，空/缺失视为失败 */
  async replyImage(chatId: string, params: { filePath: string; fileName: string; mimeType: string }): Promise<void> {
    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(params.filePath);

    // 上传：multipart/form-data（Node 原生 FormData + Blob，零新依赖）
    const form = new FormData();
    form.append("image_type", "message");
    // 飞书上传接口对扩展名不敏感（按内容探咦），文件名保留 originalName 便于溯源
    form.append("image", new Blob([buffer], { type: params.mimeType }), params.fileName || "image");

    const token = await this.tokenManager.getAccessToken();
    const uploadRes = await fetch(FEISHU_IMAGE_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });
    const uploadData = (await uploadRes.json()) as {
      code: number;
      msg: string;
      data?: { image_key?: string };
    };
    if (uploadData.code !== 0 || !uploadData.data?.image_key) {
      throw new Error(`Feishu image upload rejected: code=${uploadData.code} msg=${uploadData.msg}`);
    }
    const imageKey = uploadData.data.image_key;

    // 发送：msg_type=image
    const response = await fetch(FEISHU_MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      }),
    });
    const data = (await response.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      throw new Error(`Feishu image message rejected: code=${data.code} msg=${data.msg}`);
    }
    this.logger.info("Feishu image message sent", { chatId, fileName: params.fileName, bytes: buffer.length });
  }
}
