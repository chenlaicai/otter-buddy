/**
 * 熔断器相关的辅助函数
 */

import { ToolCallCircuitBreaker } from "./tool-call-circuit-breaker";
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
  abortOverride?: (reason?: string) => void,
): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined; clearEventTimer: () => void } {
  const circuitBreaker = new ToolCallCircuitBreaker(circuitBreakerConfig, otterId, logger);
  const doAbort = abortOverride ?? (() => { session.abort(); });

  // per-event 超时：resettable timer，每次 tool_execution_start 重置
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  const maxPerEventMs = circuitBreakerConfig.maxPerEventTimeMs;
  const clearEventTimer = () => { if (eventTimer) { clearTimeout(eventTimer); eventTimer = undefined; } };
  const resetEventTimer = () => {
    clearEventTimer();
    eventTimer = setTimeout(() => {
      logger.warn(`[circuit-breaker] PER_EVENT_TIMEOUT: otter=${otterId} elapsed=${maxPerEventMs}ms`);
      doAbort("circuit_break:event_timeout");
    }, maxPerEventMs);
  };

  /** 通过 subscribe 拦截 tool_execution_start 事件实现熔断 */
  const unregisterToolCall = session.subscribe((event: unknown) => {
    // pi-coding-agent SDK 的 tool_execution_start 事件工具名字段为 toolName（见 SDK ToolExecutionStartEvent），
    // name 仅为兼容兜底；都取不到时记为 "unknown"
    const e = event as { type?: string; toolName?: string; name?: string; args?: unknown };
    if (e.type === "tool_execution_start") {
      resetEventTimer();
      const result = circuitBreaker.check(e.toolName ?? e.name ?? "unknown", e.args);
      if (result.action === "terminate") {
        clearEventTimer();
        doAbort(`circuit_break:${result.trigger ?? "unknown"}`);
        return;
      }
      if (result.action === "steer") {
        session.steer?.(result.reason ?? "Stop calling tools. Call speak now.");
        return;
      }
    }
  });

  const originalUnregister = unregisterToolCall;
  return {
    circuitBreaker,
    unregisterToolCall: originalUnregister ? () => { clearEventTimer(); originalUnregister(); } : undefined,
    clearEventTimer,
  };
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
