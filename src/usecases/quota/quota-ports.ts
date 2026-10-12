/**
 * F20261012qtbc：配额采集端口（usecases 层定义接口，框架层实现——DIP，不反向 import）。
 */
import type { QuotaProviderId, QuotaWindow } from "./quota-types";

/** 网络拦截捕获的配额相关响应 */
export interface CapturedResponse {
  url: string;
  status: number;
  json?: unknown;
}

/** 一次页面采集的结果 */
export interface CaptureResult {
  responses: CapturedResponse[];
  /** 采集结束时页面 URL（登录跳转判定依据之一） */
  finalUrl: string;
  /** 页面被跳去登录页 */
  redirectedToLogin: boolean;
}

/** 数据源规格（框架层注册表实现；normalize 为领域纯函数绑定） */
export interface QuotaProviderSpec {
  id: QuotaProviderId;
  label: string;
  /** 控制台页 URL（采集页 & 登录页同址） */
  consoleUrl: string;
  /** 响应 URL 是否属于本 provider 的配额数据 */
  match(url: string): boolean;
  /** 从捕获响应 JSON 解析窗口；null = 结构未识别（fail-closed） */
  normalize(payload: unknown): QuotaWindow[] | null;
}

/** 会话端口（QuotaBrowserSession 实现；窄接口便于单测注入假会话） */
export interface QuotaCaptureSession {
  capture(spec: QuotaProviderSpec, timeoutMs?: number): Promise<CaptureResult>;
  openLogin(spec: QuotaProviderSpec, waitMs?: number): Promise<void>;
}
