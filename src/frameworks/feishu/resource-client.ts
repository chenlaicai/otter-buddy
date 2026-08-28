import type { Logger } from "@usecases/ports/logger";
import type {
  FeishuResourceGateway,
  FeishuResourceDownload,
} from "@usecases/im/feishu-resource-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";

/**
 * 飞书消息资源下载客户端（多模态 Phase 2）。
 *
 * GET /open-apis/im/v1/messages/{message_id}/resources/{resource_key}?type=image|file
 * 权限：image 走 im:message 体系（收消息已具备）；file 需 im:resource——
 * 权限缺失/资源过期（飞书 CDN 有时效）时返回 null，由调用方降级为文本占位。
 *
 * 响应是二进制流（Content-Type: application/octet-stream），直接 arrayBuffer；
 * 失败时飞书返回 JSON（code != 0），按 code 区分日志级别。
 */

const RESOURCE_ENDPOINT = "https://open.feishu.cn/open-apis/im/v1/messages";

/** image_key/file_key 短串：下载失败时占位展示用（截尾防超长 key 刷屏） */
function shortKey(key: string): string {
  return key.length > 24 ? `${key.slice(0, 12)}…${key.slice(-8)}` : key;
}

export class FeishuResourceClient implements FeishuResourceGateway {
  constructor(
    private readonly tokenManager: FeishuAccessTokenManager,
    private readonly logger: Logger,
  ) {}

  async downloadMessageResource(
    messageId: string,
    resourceKey: string,
    type: "image" | "file",
  ): Promise<FeishuResourceDownload | null> {
    if (!messageId || !resourceKey) return null;
    const url =
      `${RESOURCE_ENDPOINT}/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${type}`;

    try {
      const token = await this.tokenManager.getAccessToken();
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        // 飞书错误体是 JSON {code, msg}；40002=权限缺失、230002=资源不存在/过期 等
        const errBody = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
        this.logger.warn("Feishu resource download rejected", {
          messageId,
          resourceKey: shortKey(resourceKey),
          type,
          httpStatus: response.status,
          feishuCode: errBody?.code,
          msg: errBody?.msg,
        });
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        this.logger.warn("Feishu resource download returned empty body", {
          messageId,
          resourceKey: shortKey(resourceKey),
          type,
        });
        return null;
      }

      this.logger.info("Feishu resource downloaded", {
        messageId,
        resourceKey: shortKey(resourceKey),
        type,
        bytes: buffer.length,
      });
      return { buffer, fileName: "" };
    } catch (err) {
      // 网络层异常（超时/DNS）：null 降级，不重试（immediate-value：消息文本不丢即可）
      this.logger.warn("Feishu resource download request error", {
        messageId,
        resourceKey: shortKey(resourceKey),
        type,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
