/**
 * F20261012qtbc：配额采集服务——编排浏览器会话 + 三家归一化 + TTL 缓存。
 *
 * 状态机（per provider）：
 *   捕获到 401/403 或页面跳登录页 → needs-login
 *   捕获到响应且归一化成功       → ok
 *   归一化失败/采集异常          → error（fail-closed，绝不猜数字）
 *
 * 缓存：TTL 内直接回缓存（含 needs-login/error 状态，避免反复开浏览器）；
 * refresh=true 强制重采；openLogin 后清该 provider 缓存。
 *
 * 边界（搭档拍板）：纯展示——本服务不写观测数据、不接调度、不发通知。
 */
import type { Logger } from "@usecases/ports/logger";
import type {
  CapturedResponse,
  QuotaCaptureSession,
  QuotaProviderSpec,
} from "./quota-ports";
import type {
  ProviderQuota,
  QuotaProviderId,
  QuotaSnapshot,
  QuotaWindow,
} from "./quota-types";

const DEFAULT_TTL_MS = 5 * 60_000;

interface CacheEntry {
  data: ProviderQuota;
  at: number;
}

export class QuotaService {
  private readonly cache = new Map<QuotaProviderId, CacheEntry>();

  constructor(
    private readonly opts: {
      session: QuotaCaptureSession;
      providers: QuotaProviderSpec[];
      logger: Logger;
      ttlMs?: number;
      captureTimeoutMs?: number;
      now?: () => number;
    },
  ) {}

  async getSnapshot(options?: { refresh?: boolean }): Promise<QuotaSnapshot> {
    const ttl = this.opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = (this.opts.now ?? Date.now)();
    let usedCache = false;
    const providers: ProviderQuota[] = [];
    for (const spec of this.opts.providers) {
      const cached = this.cache.get(spec.id);
      if (!options?.refresh && cached && now - cached.at < ttl) {
        providers.push(cached.data);
        usedCache = true;
        continue;
      }
      providers.push(await this.collectOne(spec));
    }
    return { providers, stale: usedCache };
  }

  /** 弹登录窗（面板按钮触发）；完成后清缓存，下次刷新重采 */
  async openLogin(provider: QuotaProviderId): Promise<void> {
    const spec = this.opts.providers.find(p => p.id === provider);
    if (!spec) throw new Error(`unknown quota provider: ${provider}`);
    await this.opts.session.openLogin(spec);
    this.cache.delete(provider);
  }

  private async collectOne(spec: QuotaProviderSpec): Promise<ProviderQuota> {
    const fetchedAt = new Date().toISOString();
    try {
      const result = await this.opts.session.capture(spec, this.opts.captureTimeoutMs ?? 20_000);
      const authBlocked =
        result.redirectedToLogin ||
        result.responses.some(r => r.status === 401 || r.status === 403);
      if (authBlocked) {
        return this.put(spec, {
          provider: spec.id,
          label: spec.label,
          status: "needs-login",
          windows: [],
          fetchedAt,
          error: "网页登录态缺失或过期，请重新登录",
        });
      }
      const windows = this.firstWindows(spec, result.responses);
      if (!windows) {
        return this.put(spec, {
          provider: spec.id,
          label: spec.label,
          status: "error",
          windows: [],
          fetchedAt,
          error: "配额响应结构未识别（原始响应已落日志，待锁定字段映射）",
        });
      }
      return this.put(spec, {
        provider: spec.id,
        label: spec.label,
        status: "ok",
        windows,
        fetchedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger.error(`[quota] ${spec.label} 采集失败: ${message}`);
      return this.put(spec, {
        provider: spec.id,
        label: spec.label,
        status: "error",
        windows: [],
        fetchedAt,
        error: message,
      });
    }
  }

  /** 逐响应归一化，取第一组成功结果；全失败时落 raw 日志辅助定名 */
  private firstWindows(spec: QuotaProviderSpec, responses: CapturedResponse[]): QuotaWindow[] | null {
    for (const res of responses) {
      if (res.json === undefined) continue;
      const windows = spec.normalize(res.json);
      if (windows) return windows;
    }
    // fail-closed + 可观测：把未识别的原始响应（截断）落日志，供字段映射锁定
    for (const res of responses) {
      const raw = JSON.stringify(res.json ?? null).slice(0, 2000);
      this.opts.logger.info(`[quota] ${spec.id} 未识别响应 ${res.url} → ${raw}`);
    }
    return null;
  }

  private put(spec: QuotaProviderSpec, data: ProviderQuota): ProviderQuota {
    this.cache.set(spec.id, { data, at: (this.opts.now ?? Date.now)() });
    return data;
  }
}
