import type { Logger } from "@usecases/ports/logger";

export interface FeishuTokenConfig {
  appId: string;
  appSecret: string;
}

/**
 * 飞书 tenant_access_token 管理器。
 * - 自动缓存，过期前 5 分钟刷新
 * - 并发安全：多个调用者共享同一个 refresh promise
 */
export class FeishuAccessTokenManager {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly config: FeishuTokenConfig,
    private readonly logger: Logger,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.doRefreshToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<string> {
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
    this.tokenExpiresAt = Date.now() + (data.expire - 300) * 1000;
    this.logger.info("Feishu access token refreshed", { expiresIn: data.expire });
    return this.accessToken;
  }
}
