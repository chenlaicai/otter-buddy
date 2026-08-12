import type { Logger } from "@usecases/ports/logger";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";
import type { FeishuConfig } from "./types";

export type { FeishuConfig };

const FEISHU_MESSAGES_ENDPOINT = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";

/** 降级前缀:post + md 发送失败时,转 replyText 用纯文本兜底,标记体感落差 */
const DEGRADE_PREFIX = "[纯文本降级]\n\n";

export class FeishuClient implements FeishuGateway {
  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
    private readonly tokenManager: FeishuAccessTokenManager,
  ) {}

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
}
