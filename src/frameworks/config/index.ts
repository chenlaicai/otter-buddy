/**
 * 配置入口：loadConfig 从文件加载，initConfig/getConfig 管理进程级单例。
 * 实际实现见同级 config-service.ts。
 */
export { loadConfig, type AppConfig, type ModelConfig } from "../config-service";
import type { AppConfig } from "../config-service";

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
