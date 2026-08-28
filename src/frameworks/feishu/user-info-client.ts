import type { Logger } from "@usecases/ports/logger";
import type { FeishuUserInfoGateway } from "@usecases/im/feishu-user-info-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";

/**
 * 飞书用户信息客户端（F20260826fuid）。
 *
 * 调用 GET /open-apis/contact/v3/users/{open_id}?user_id_type=open_id，
 * 需权限 contact:contact.base:readonly（获取通讯录基本信息；注意不是
 * contact:user.base:readonly——该名称不存在，是 #488 时期文档笔误，实测
 * API 权限拒绝时飞书返回的必需清单为 contact:contact.base:readonly /
 * contact:contact:access_as_app / contact:contact:readonly 系列）。
 *
 * 设计要点：
 * - 进程内 Map 缓存 open_id → name，命中不出网；未命中 TTL 过期后重查一次
 * - API 失败（权限未开/限流/网络）→ 返回 null + 单条 warn 日志，不抛错不重试风暴
 * - 仅 cache 正结果；null 结果不缓存（权限开通后自动恢复，无需重启）
 */
const USER_ENDPOINT = "https://open.feishu.cn/open-apis/contact/v3/users/";

/** 缓存 TTL：飞书姓名变更低频，10 分钟足够 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  name: string;
  fetchedAt: number;
}

export class FeishuUserInfoClient implements FeishuUserInfoGateway {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly tokenManager: FeishuAccessTokenManager,
    private readonly logger: Logger,
  ) {}

  async getUserName(openId: string): Promise<string | null> {
    if (!openId || openId === "unknown") return null;

    const cached = this.cache.get(openId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.name;
    }

    try {
      const token = await this.tokenManager.getAccessToken();
      const response = await fetch(`${USER_ENDPOINT}${encodeURIComponent(openId)}?user_id_type=open_id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as {
        code: number;
        msg: string;
        data?: { user?: { name?: string } };
      };

      if (data.code !== 0 || !data.data?.user?.name) {
        // 99991672 = 权限未开通。缓存命中前每次都会打，控制为 warn 级别并附 code 便于排查
        this.logger.warn("Feishu user info query failed", { openId, code: data.code, msg: data.msg });
        return null;
      }

      const name = data.data.user.name;
      this.cache.set(openId, { name, fetchedAt: Date.now() });
      this.logger.info("Feishu user name resolved", { openId, name });
      return name;
    } catch (err) {
      this.logger.warn("Feishu user info request error", { openId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}
