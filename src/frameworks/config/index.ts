/**
 * Barrel export：保持 `import { config } from "@frameworks/config"` 路径不变。
 * 实际实现见同级 config-service.ts。
 */
export { loadConfig, type AppConfig, type ModelConfig } from "../config-service";
import type { AppConfig } from "../config-service";

/**
 * 延迟初始化的配置对象。
 * 在 main.ts 中调用 initConfig(logger) 初始化。
 */
let _config: AppConfig | null = null;

/**
 * 初始化配置。
 * 在 main.ts 中调用，传递 logger 记录配置加载日志。
 */
export function initConfig(config: AppConfig): void {
  _config = config;
}

/**
 * 获取配置。
 * 必须在 initConfig() 之后调用。
 */
export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return _config;
}

/**
 * 兼容旧代码的 config 导出。
 * 使用 getter 延迟获取配置。
 */
export const config: AppConfig = new Proxy({} as AppConfig, {
  get(_target, prop) {
    return getConfig()[prop as keyof AppConfig];
  },
});
