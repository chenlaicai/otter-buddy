/**
 * 熔断器相关的辅助函数
 */

import { ToolCallCircuitBreaker } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";

/** Token 阈值（超过则记录警告，与旧实现一致） */
export const TOKEN_WARNING_THRESHOLD = 100_000;

/** 熔断器 tool_execution_start 钩子 */
// eslint-disable-next-line max-lines-per-function
export function attachCircuitBreaker(
  session: { subscribe: (fn: (event: unknown) => void) => () => void; steer?: (text: string) => Promise<void>; abort: () => Promise<void> },
  otterId: string,
  circuitBreakerConfig: CircuitBreakerConfig,
  logger: Logger,
  abortOverride?: (reason?: string) => void,
): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined; clearEventTimer: (toolCallId?: string) => void } {
  const circuitBreaker = new ToolCallCircuitBreaker(circuitBreakerConfig, otterId, logger);
  const doAbort = abortOverride ?? (() => { session.abort(); });

  // per-event 超时：只计单次工具执行时间（start → end），不覆盖工具间的 LLM 思考时间
  // 按 toolCallId 分别跟踪计时器，支持并行工具调用（issue #140）
  const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxPerEventMs = circuitBreakerConfig.maxPerEventTimeMs;
  const clearEventTimer = (toolCallId?: string) => {
    if (toolCallId) {
      const timer = eventTimers.get(toolCallId);
      if (timer) { clearTimeout(timer); eventTimers.delete(toolCallId); }
    } else {
      // 清除所有计时器（用于 unregister 等场景）
      for (const timer of eventTimers.values()) clearTimeout(timer);
      eventTimers.clear();
    }
  };

  /** 通过 subscribe 拦截 tool_execution_start / tool_execution_end 事件实现熔断 */
  // eslint-disable-next-line complexity
  const unregisterToolCall = session.subscribe((event: unknown) => {
    const e = event as { type?: string; toolCallId?: string; toolName?: string; name?: string; args?: unknown };
    if (e.type === "tool_execution_start") {
      const toolCallId = e.toolCallId;
      if (!toolCallId) {
        logger.warn(`[circuit-breaker] tool_execution_start missing toolCallId, skipping per-event timer`);
      } else {
        // 启动 per-event 计时器（按 toolCallId 独立跟踪，支持并行工具调用）
        clearEventTimer(toolCallId);
        const timer = setTimeout(() => {
          logger.warn(`[circuit-breaker] PER_EVENT_TIMEOUT: otter=${otterId} toolCallId=${toolCallId} elapsed=${maxPerEventMs}ms`);
          doAbort("circuit_break:event_timeout");
        }, maxPerEventMs);
        eventTimers.set(toolCallId, timer);
      }

      const toolName = e.toolName ?? e.name ?? "unknown";
      const result = circuitBreaker.check(toolName, e.args);
      if (result.action === "terminate") {
        // terminate 时清除所有计时器（避免其他并行工具的计时器在 abort 后继续运行）
        clearEventTimer();
        doAbort(`circuit_break:${result.trigger ?? "unknown"}`);
        return;
      }
      if (result.action === "steer") {
        if (toolName !== "speak") session.steer?.(result.reason ?? "Stop calling tools. Call speak now."); // F20260806cbsl: speak 是回合出口，对其 steer 有害无益
        return;
      }
    }
    if (e.type === "tool_execution_end") {
      // 工具执行完成，只清除该工具的计时器（LLM 思考时间不计入 per-event 超时）
      if (!e.toolCallId) {
        logger.warn(`[circuit-breaker] tool_execution_end missing toolCallId, skipping timer cleanup`);
      } else {
        clearEventTimer(e.toolCallId);
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
