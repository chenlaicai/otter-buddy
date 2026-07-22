/**
 * 熔断器相关的辅助函数
 */

import { ToolCallCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";

/** Token 阈值（超过则记录警告，与旧实现一致） */
export const TOKEN_WARNING_THRESHOLD = 100_000;

/** 熔断器 tool_execution_start 钩子 */
export function attachCircuitBreaker(
  session: { subscribe: (fn: (event: unknown) => void) => () => void; steer?: (text: string) => Promise<void>; abort: () => Promise<void> },
  otterId: string,
  circuitBreakerConfig: CircuitBreakerConfig,
  logger: Logger,
): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined } {
  const circuitBreaker = new ToolCallCircuitBreaker(circuitBreakerConfig, otterId, logger);

  /** 通过 subscribe 拦截 tool_execution_start 事件实现熔断 */
  const unregisterToolCall = session.subscribe((event: unknown) => {
    const e = event as { type?: string; name?: string };
    if (e.type === "tool_execution_start") {
      const result = circuitBreaker.check(e.name ?? "unknown");
      if (result.action === "terminate") {
        session.abort();
        return;
      }
      if (result.action === "steer") {
        session.steer?.(result.reason ?? "Stop calling tools. Call speak now.");
        circuitBreaker.setSteerDeadline(() => { session.abort(); });
        return;
      }
    }
  });

  return { circuitBreaker, unregisterToolCall };
}

/** token 超阈值警告 */
export function checkTokenWarning(otterId: string, tokens: { input: number; output: number }, logger: Logger): void {
  const total = tokens.input + tokens.output;
  if (total > TOKEN_WARNING_THRESHOLD) {
    logger.warn(`[token-warning] otter=${otterId} total=${total} threshold=${TOKEN_WARNING_THRESHOLD}`);
  }
}

/** 构建执行结果（含熔断器元数据） */
export function buildResult(
  text: string,
  tokenUsage?: { input: number; output: number },
  circuitBreaker?: ToolCallCircuitBreaker,
  ctxMax?: number,
) {
  return {
    text,
    tokenUsage: tokenUsage
      ? { input: tokenUsage.input, output: tokenUsage.output }
      : undefined,
    ctxMax,
    circuitBreakerMetadata: circuitBreaker?.getMetadata(),
  };
}
