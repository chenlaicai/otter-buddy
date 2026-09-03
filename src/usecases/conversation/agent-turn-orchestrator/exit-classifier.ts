/**
 * Exit reason classification for agent invocation.
 *
 * Why: 从 agent-invoker.ts 抽取退出分类逻辑，降低编排文件体积。
 * exit-classifier 是"状态+依赖注入函数"（依赖 userAbortedMessages 与
 * getInternalAbortReason），测试面按此设计，不声称纯函数。
 */

import type { InvokeOutcome } from "@usecases/ports/agent-metrics-port";

/** Agent invocation exit reason classification */
export type ExitReason =
  | { kind: 'user_abort'; toolCallCount: number; /** #752：用户中断时的底层 SDK 错误（api_error/timeout 等），用于中断归因 */ underlyingError?: { kind: 'api_error'; errorMessage: string } | { kind: 'guard_abort'; guardReason: string } | { kind: 'no_yield' } }
  | { kind: 'guard_abort'; guardReason: string; toolCallCount: number }
  | { kind: 'api_error'; errorMessage: string; toolCallCount: number }
  | { kind: 'no_yield'; toolCallCount: number };

/** Extract guard abort reason from result or error (single source of truth) */
export function extractGuardReason(
  messageId: string,
  result: unknown,
  err: unknown,
  getInternalAbortReason: (messageId: string) => string | undefined,
): string | undefined {
  const fromResult = (result as Record<string, unknown>)?._guardAbortReason as string | undefined;
  if (fromResult) return fromResult;
  const fromErr = (err as { _guardAbortReason?: string })?._guardAbortReason;
  if (fromErr) return fromErr;
  return getInternalAbortReason(messageId);
}

/** Classify the exit reason from invocation result or error */
export function classifyExit(
  p: {
    messageId: string;
    result?: { text: string; tokenUsage?: { input: number; output: number }; ctxTokens?: number; ctxMax?: number };
    err?: unknown;
    toolCallCount: number;
  },
  userAbortedMessages: Set<string>,
  getInternalAbortReason: (messageId: string) => string | undefined,
): ExitReason {
  if (userAbortedMessages.has(p.messageId)) {
    // #752：用户中断时保留底层错误信息用于中断归因（用户中断掩盖底层 API 错误的场景）
    let underlyingError: { kind: 'api_error'; errorMessage: string } | { kind: 'guard_abort'; guardReason: string } | { kind: 'no_yield' } | undefined;
    const guardReason = extractGuardReason(p.messageId, p.result, p.err, getInternalAbortReason);
    if (guardReason) {
      underlyingError = { kind: 'guard_abort', guardReason };
    } else if (p.err) {
      const msg = p.err instanceof Error ? p.err.message : String(p.err);
      underlyingError = { kind: 'api_error', errorMessage: msg };
    } else if (p.toolCallCount === 0) {
      underlyingError = { kind: 'no_yield' };
    }
    return { kind: 'user_abort', toolCallCount: p.toolCallCount, underlyingError };
  }

  const guardReason = extractGuardReason(p.messageId, p.result, p.err, getInternalAbortReason);
  if (guardReason) {
    return { kind: 'guard_abort', guardReason, toolCallCount: p.toolCallCount };
  }

  if (p.err) {
    const msg = p.err instanceof Error ? p.err.message : String(p.err);
    return { kind: 'api_error', errorMessage: msg, toolCallCount: p.toolCallCount };
  }

  return { kind: 'no_yield', toolCallCount: p.toolCallCount };
}

/** ExitReason.kind → outcome 枚举映射（tryCompleteSpeaking err 收尾复用） */
export function exitKindToOutcome(kind: ExitReason["kind"], retryCount: number): InvokeOutcome {
  switch (kind) {
    case 'user_abort':
      return 'user_abort';
    case 'guard_abort':
      return 'guard_abort';
    case 'api_error':
      return 'api_error';
    default:
      return retryCount === 0 ? 'no_yield_retry' : 'no_yield_failed';
  }
}
