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

export interface CapturedLogs {
  infos: string[];
  warns: string[];
  errors: string[];
  debugs: string[];
}

/** 捕获型 Logger：断言"打没打某条日志"时使用（如降级路径的 warn） */
export function createCapturingLogger(): Logger & { captured: CapturedLogs } {
  const captured: CapturedLogs = { infos: [], warns: [], errors: [], debugs: [] };
  const logger: Logger & { captured: CapturedLogs } = {
    info: (m) => { captured.infos.push(m); },
    warn: (m) => { captured.warns.push(m); },
    error: (m) => { captured.errors.push(m); },
    debug: (m) => { captured.debugs.push(m); },
    child: () => logger,
    captured,
  };
  return logger;
}
