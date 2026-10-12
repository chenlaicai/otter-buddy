/**
 * F20261012qtbc：配额（token 余量）统一展示——领域类型。
 *
 * 边界（搭档拍板 2026-10-12，边界即需求）：
 * 纯展示——不进观测数据（healing/警报/指标）、不影响调度与模型选择、无通知开关。
 * 与 F20260902sgp2（429 降级链路）零耦合：本模块不读不写该链路。
 */

/** 数据源提供方（三家订阅账号控制台） */
export type QuotaProviderId = "glm" | "kimi" | "mimo";

/** 采集状态：
 *  - ok：拿到并识别出配额窗口
 *  - needs-login：网页登录态缺失/过期（401/403/跳登录页）
 *  - error：采集失败或响应结构未识别（fail-closed，绝不猜数字） */
export type ProviderQuotaStatus = "ok" | "needs-login" | "error";

/** 单个用量窗口（按家配窗口：GLM 5h+周、Kimi 5h+7日、MiMo 单余量——窗口数量不固定） */
export interface QuotaWindow {
  /** 稳定键：'5h' | 'week' | 'month' | 'total' | 'w<n>' */
  key: string;
  /** 展示名（如 '5 小时'、'本周'、'总量'） */
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** 剩余比例 0..1；无法计算时为 null */
  remainingRatio: number | null;
  /** 重置时间 ISO8601；未知为 null */
  resetAt: string | null;
}

export interface ProviderQuota {
  provider: QuotaProviderId;
  /** 账号展示名（'智谱 GLM' / 'Kimi' / 'MiMo'） */
  label: string;
  status: ProviderQuotaStatus;
  windows: QuotaWindow[];
  /** 采集时间 ISO8601 */
  fetchedAt: string;
  /** status 非 ok 时的人话原因 */
  error?: string;
}

export interface QuotaSnapshot {
  providers: ProviderQuota[];
  /** true = 含 TTL 缓存数据（非本次全量新鲜采集） */
  stale: boolean;
}
