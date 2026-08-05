/**
 * 共享测试 Logger 工厂。替代各测试文件中 24 份重复的 mockLogger/noopLogger 副本。
 */
import type { Logger } from "@usecases/ports/logger";

/** noop Logger：child 递归返回自身，满足 Logger 接口全部方法。 */
export function createTestLogger(): Logger {
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}
