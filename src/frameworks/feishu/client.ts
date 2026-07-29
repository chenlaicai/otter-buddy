import type { Logger } from "@usecases/ports/logger";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

export class FeishuClient implements FeishuGateway {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
  ) {}

  /** 获取 tenant_access_token（自动缓存，过期前刷新） */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const data = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code !== 0) {
      throw new Error(`Failed to get access token: ${data.msg}`);
    }

    this.accessToken = data.tenant_access_token;
    // 提前 5 分钟刷新
    this.tokenExpiresAt = Date.now() + (data.expire - 300) * 1000;

    this.logger.info("Feishu access token refreshed", {
      expiresIn: data.expire,
    });

    return this.accessToken;
  }

  /** 发送文本消息到群 */
  async replyText(chatId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();

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

    // 飞书签名验证逻辑
    // 参考: https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
    const crypto = require("crypto");
    const content = timestamp + nonce + this.config.encryptKey + body;
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return hash === signature;
  }

  /** 处理 URL Verification Challenge */
  handleChallenge(challenge: string): { challenge: string } {
    return { challenge };
  }

  /** 解密加密的事件数据 */
  decryptEventData(encryptedData: string): string {
    if (!this.config.encryptKey) {
      return encryptedData;
    }

    const crypto = require("crypto");
    const key = crypto.createHash("sha256").update(this.config.encryptKey).digest();
    const encrypted = Buffer.from(encryptedData, "base64");
    const iv = encrypted.subarray(0, 16);
    const data = encrypted.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(data);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString("utf8");
  }
}
