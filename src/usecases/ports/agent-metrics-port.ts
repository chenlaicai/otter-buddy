/**
 * AgentMetrics 端口（F20260814mtrc）
 *
 * usecases/interface-adapters 只依赖此接口；实现位于 frameworks/metrics/agent-metrics.ts
 * （prom-client）。分层约束：interface-adapters 不许 import frameworks。
 *
 * 指标语义契约（重构不许漂移）见 F20260814mtrc"指标语义契约"节：
 * outcome/retry/source/guard reason 均为封闭枚举，token 为 attempt 增量。
 */

/** invoke 尝试的退出结果（封闭枚举） */
export type InvokeOutcome =
  | "success"
  | "user_abort"
  | "guard_abort"
  | "api_error"
  | "no_yield_retry"
  | "no_yield_failed";

/** retry label 值：首轮 | invoker/SDK 自动重试 | 用户手动重试 */
export type RetryLabel = "0" | "auto" | "manual";

/** 重试种类（SDK 层 + invoker 层，封闭枚举） */
export type RetryKind =
  | "sdk_auto"
  | "degenerate_output"
  | "degenerate_detected" // F20260831dgrt：首次退化检测（非实际重试），与 degenerate_output 语义分离
  | "no_yield"
  | "streaming_timeout"
  | "first_byte_timeout"
  | "circuit_break";

/** 一次 invoke attempt 的退出画像 */
export interface InvokeOutcomeRecord {
  otterId: string;
  model: string;
  otterType: string;
  source: string;
  outcome: InvokeOutcome;
  retry: RetryLabel;
  durationMs: number;
  /** session 累计值（实现内部差分为 attempt 增量） */
  tokenUsage?: { input: number; output: number };
  ctxTokens?: number;
  firstByteLatencyMs?: number;
}

export interface AgentMetricsPort {
  recordInvoke(r: InvokeOutcomeRecord): void;
  recordRetry(kind: RetryKind): void;
  recordGuardAbort(model: string, reason: string): void;
  recordToolCall(tool: string): void;
  recordToolDuration(tool: string, durationMs: number): void;
  recordToolError(tool: string): void;
  recordCompaction(reason: string, aborted: boolean): void;
  recordSessionRebuild(): void;
  recordChainHops(count: number): void;
  recordChainDepthExceeded(): void;
  /** F20260821spcm: 旁白流失计数——LLM 输出了直出文本但未调 speak（按 otterId 分组） */
  recordNoYieldWithOrphanText(otterId: string): void;
}

/** retryCount + manual 标识 → retry label 值（封闭枚举） */
export function toRetryLabel(retryCount: number, manual: boolean): RetryLabel {
  if (retryCount <= 0) return "0";
  return manual ? "manual" : "auto";
}
