/**
 * F20261012qtbc：配额看板 HTTP 端点。
 *  - GET  /api/quota?refresh=1   —— 三家账号余量快照（默认走 5 分钟 TTL 缓存）
 *  - POST /api/quota/login       —— 弹有头浏览器窗让搭档扫码登录（body: { provider }）
 *
 * 边界：纯展示读取 + 登录辅助，不写观测数据、不影响调度（搭档拍板 2026-10-12）。
 */
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { QuotaService } from "@usecases/quota/quota-service";
import type { QuotaProviderId } from "@usecases/quota/quota-types";
import { handleError } from "../http-error";

const PROVIDER_IDS: QuotaProviderId[] = ["glm", "kimi", "mimo"];

export class QuotaController {
  constructor(
    private readonly service: QuotaService,
    private readonly logger: Logger,
  ) {}

  /** GET /api/quota —— 余量快照（refresh=1 强制重采） */
  async getQuota(c: Context): Promise<Response> {
    try {
      const refresh = c.req.query("refresh") === "1";
      return c.json(await this.service.getSnapshot({ refresh }));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** POST /api/quota/login —— 弹登录窗（阻塞至搭档关窗或超时，故设长超时） */
  async login(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<{ provider?: string }>().catch(() => ({}) as { provider?: string });
      const provider = body.provider;
      if (!PROVIDER_IDS.includes(provider as QuotaProviderId)) {
        return c.json({ error: `unknown provider: ${String(provider)}` }, 400);
      }
      await this.service.openLogin(provider as QuotaProviderId);
      return c.json({ status: "ok" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
