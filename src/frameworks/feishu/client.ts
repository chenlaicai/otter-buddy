import { createHash, createDecipheriv } from "node:crypto";
import type { Logger } from "@usecases/ports/logger";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;  // 必填
  encryptKey?: string;
}

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

  /** 验证 Webhook 签名 */
  verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean {
    if (!this.config.encryptKey) {
      return true; // 未配置加密密钥时跳过验证
    }

    const content = timestamp + nonce + this.config.encryptKey + body;
    const hash = createHash("sha256").update(content).digest("hex");
    return hash === signature;
  }

  /** 解密加密的事件数据 */
  decryptEventData(encryptedData: string): string {
    if (!this.config.encryptKey) {
      return encryptedData;
    }

    const key = createHash("sha256").update(this.config.encryptKey).digest();
    const encrypted = Buffer.from(encryptedData, "base64");
    const iv = encrypted.subarray(0, 16);
    const data = encrypted.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(data);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString("utf8");
  }
}
