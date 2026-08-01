import type { Logger } from "@usecases/ports/logger";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";
import type { FeishuConfig } from "./types";

export type { FeishuConfig };

export class FeishuClient implements FeishuGateway {
  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
    private readonly tokenManager: FeishuAccessTokenManager,
  ) {}

  /** 发送文本消息到群 */
  async replyText(chatId: string, text: string): Promise<void> {
    const token = await this.tokenManager.getAccessToken();

    const response = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
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
      },
    );

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

}
