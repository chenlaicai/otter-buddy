/**
 * F20261012qtbc：三家控制台配额数据源注册表（框架层装配：URL 匹配 + 领域归一化绑定）。
 * 归一化纯函数在 @usecases/quota/quota-normalize；端口类型在 @usecases/quota/quota-ports（DIP）。
 *
 * 采集方式 = 访问控制台页 + 网络拦截配额 XHR（与控制台显示同源，端点变更自愈）。
 */
import type { QuotaProviderSpec } from "@usecases/quota/quota-ports";
import { normalizeGlm, normalizeKimi, normalizeMimo } from "@usecases/quota/quota-normalize";

export const QUOTA_PROVIDERS: QuotaProviderSpec[] = [
  {
    id: "glm",
    label: "智谱 GLM",
    consoleUrl: "https://bigmodel.cn/coding-plan/personal/usage",
    match: (url) => url.includes("/monitor/usage/quota"),
    normalize: normalizeGlm,
  },
  {
    id: "kimi",
    label: "Kimi",
    consoleUrl: "https://www.kimi.com/code/console",
    match: (url) => url.includes("/apiv2"),
    normalize: normalizeKimi,
  },
  {
    id: "mimo",
    label: "MiMo",
    consoleUrl: "https://platform.xiaomimimo.com/console/plan-manage",
    match: (url) => url.includes("/tokenPlan/"),
    normalize: normalizeMimo,
  },
];
