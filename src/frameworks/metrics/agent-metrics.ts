/**
 * Agent/LLM 链路的 metric 实现（F20260814mtrc）
 *
 * 实现 usecases/ports/agent-metrics-port（分层：interface-adapters/usecases 只依赖 port）。
 *
 * 注册的指标：
 * - agent_invoke_total{model, otter_type, source, outcome, retry}   counter  invoke 尝试次数（attempt 粒度）
 * - agent_invoke_duration_ms{model, otter_type, outcome}            histogram 单次 attempt 耗时（含前置开销与 session 锁排队）
 * - agent_token_input_total{model, otter_type}                      counter  attempt 增量输入 token
 * - agent_token_output_total{model, otter_type}                     counter  attempt 增量输出 token
 * - agent_context_tokens{model, otter_type}                         histogram 上下文窗口占用（末次 LLM 调用口径）
 * - agent_first_byte_latency_ms{model}                              histogram LLM 首字节延迟
 * - agent_retry_total{kind}                                         counter  重试次数（SDK 层 + invoker 层）
 * - agent_guard_abort_total{model, reason}                          counter  守卫中断次数
 * - agent_tool_calls_total{tool}                                    counter  工具调用次数
 * - agent_tool_duration_ms{tool}                                    histogram 工具执行耗时
 * - agent_tool_errors_total{tool}                                   counter  工具执行错误次数
 * - agent_compaction_total{reason, aborted}                         counter  SDK compaction 次数
 * - agent_session_rebuild_total                                     counter  session 重建次数（丢失/损坏/重启）
 * - agent_chain_hops                                                histogram 发言链 hop 数
 * - agent_chain_depth_exceeded_total                                counter  发言链触达深度上限次数
 *
 * 口径（指标语义契约，重构不许漂移——见 F 文档"指标语义契约"节）：
 * - guard reason 归一化封闭枚举：degenerate_output | streaming_timeout | first_byte_timeout
 *   | circuit_break | internal_abort | other（circuit_break:* 归一化，未知归 other）
 * - token 为 attempt 增量：tokenUsage 是 session 累计值，按 otterId 缓存上次快照差分；
 *   cur < last（session 重置）时取 cur 全量。otterId 仅作缓存 key，不入 label。
 * - 高基数字段（messageId/otterId/conversationId/errorMessage）严禁入 label。
 */
import type { Counter, Histogram } from "prom-client";
import type { MetricsRegistry } from "./registry";
import type { AgentMetricsPort, InvokeOutcomeRecord, RetryKind } from "@usecases/ports/agent-metrics-port";

const INVOKE_LABELS = ["model", "otter_type", "source", "outcome", "retry"] as const;
const DURATION_LABELS = ["model", "otter_type", "outcome"] as const;
const TOKEN_LABELS = ["model", "otter_type"] as const;
const MODEL_LABELS = ["model"] as const;
const GUARD_LABELS = ["model", "reason"] as const;
const TOOL_LABELS = ["tool"] as const;
const COMPACTION_LABELS = ["reason", "aborted"] as const;

/** guard abort reason 归一化到封闭枚举 */
function normalizeGuardReason(reason: string): string {
  if (reason.startsWith("circuit_break:")) return "circuit_break";
  switch (reason) {
    case "degenerate_output":
    case "streaming_timeout":
    case "first_byte_timeout":
    case "internal_abort":
      return reason;
    default:
      return "other";
  }
}

export class AgentMetrics implements AgentMetricsPort {
  /** 构造器内经 build* 方法赋值 */
  private readonly invokeTotal: Counter<string>;
  private readonly invokeDuration: Histogram<string>;
  private readonly tokenInput: Counter<string>;
  private readonly tokenOutput: Counter<string>;
  private readonly contextTokens: Histogram<string>;
  private readonly firstByteLatency: Histogram<string>;
  private readonly retryTotal: Counter<string>;
  private readonly guardAbortTotal: Counter<string>;
  private readonly toolCallsTotal: Counter<string>;
  private readonly toolDuration: Histogram<string>;
  private readonly toolErrorsTotal: Counter<string>;
  private readonly compactionTotal: Counter<string>;
  private readonly sessionRebuildTotal: Counter<string>;
  private readonly chainHops: Histogram<string>;
  private readonly chainDepthExceededTotal: Counter<string>;
  /** F20260821spcm: 旁白流失计数 */
  private readonly noYieldWithOrphanTextTotal: Counter<string>;

  /** otterId → 上次 session 累计 token 快照（attempt 增量差分用；基数=獭数） */
  private lastTokenSnapshot = new Map<string, { input: number; output: number }>();

  constructor(registry: MetricsRegistry) {
    const invoke = AgentMetrics.buildInvokeMetrics(registry);
    this.invokeTotal = invoke.invokeTotal;
    this.invokeDuration = invoke.invokeDuration;
    this.tokenInput = invoke.tokenInput;
    this.tokenOutput = invoke.tokenOutput;
    this.contextTokens = invoke.contextTokens;
    this.firstByteLatency = invoke.firstByteLatency;

    const retryGuard = AgentMetrics.buildRetryGuardMetrics(registry);
    this.retryTotal = retryGuard.retryTotal;
    this.guardAbortTotal = retryGuard.guardAbortTotal;
    this.compactionTotal = retryGuard.compactionTotal;
    this.sessionRebuildTotal = retryGuard.sessionRebuildTotal;

    const tool = AgentMetrics.buildToolMetrics(registry);
    this.toolCallsTotal = tool.toolCallsTotal;
    this.toolDuration = tool.toolDuration;
    this.toolErrorsTotal = tool.toolErrorsTotal;

    const chain = AgentMetrics.buildChainMetrics(registry);
    this.chainHops = chain.chainHops;
    this.chainDepthExceededTotal = chain.chainDepthExceededTotal;
    this.noYieldWithOrphanTextTotal = chain.noYieldWithOrphanTextTotal;
  }

  private static buildInvokeMetrics(registry: MetricsRegistry) {
    return {
      invokeTotal: registry.counter({
        name: "agent_invoke_total",
        help: "Agent invocation attempts by outcome (attempt granularity)",
        labelNames: INVOKE_LABELS,
      }),
      invokeDuration: registry.histogram({
        name: "agent_invoke_duration_ms",
        help: "Agent invocation duration in ms (includes prelude overhead and session lock queueing)",
        labelNames: DURATION_LABELS,
        buckets: [500, 1e3, 5e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3],
      }),
      tokenInput: registry.counter({
        name: "agent_token_input_total",
        help: "Input tokens consumed per invocation attempt (session-cumulative diff)",
        labelNames: TOKEN_LABELS,
      }),
      tokenOutput: registry.counter({
        name: "agent_token_output_total",
        help: "Output tokens consumed per invocation attempt (session-cumulative diff)",
        labelNames: TOKEN_LABELS,
      }),
      contextTokens: registry.histogram({
        name: "agent_context_tokens",
        help: "Context window occupancy at end of invocation (last LLM call)",
        labelNames: TOKEN_LABELS,
        buckets: [1e3, 5e3, 1e4, 2e4, 5e4, 1e5, 1.5e5, 2e5],
      }),
      firstByteLatency: registry.histogram({
        name: "agent_first_byte_latency_ms",
        help: "LLM first-byte latency in ms",
        labelNames: MODEL_LABELS,
        buckets: [100, 250, 500, 1e3, 2500, 5e3, 10e3, 30e3, 60e3],
      }),
    };
  }

  private static buildRetryGuardMetrics(registry: MetricsRegistry) {
    return {
      retryTotal: registry.counter({
        name: "agent_retry_total",
        help: "Retry attempts by kind (SDK auto-retry and invoker-level retries)",
        labelNames: ["kind"],
      }),
      guardAbortTotal: registry.counter({
        name: "agent_guard_abort_total",
        help: "Guard aborts by normalized reason",
        labelNames: GUARD_LABELS,
      }),
      compactionTotal: registry.counter({
        name: "agent_compaction_total",
        help: "SDK context compaction events",
        labelNames: COMPACTION_LABELS,
      }),
      sessionRebuildTotal: registry.counter({
        name: "agent_session_rebuild_total",
        help: "Agent sessions rebuilt from scratch (missing/corrupted/restarted)",
      }),
    };
  }

  private static buildToolMetrics(registry: MetricsRegistry) {
    return {
      toolCallsTotal: registry.counter({
        name: "agent_tool_calls_total",
        help: "Tool calls by tool name",
        labelNames: TOOL_LABELS,
      }),
      toolDuration: registry.histogram({
        name: "agent_tool_duration_ms",
        help: "Tool execution duration in ms",
        labelNames: TOOL_LABELS,
        buckets: [10, 50, 100, 500, 1e3, 5e3, 10e3, 30e3, 60e3, 120e3],
      }),
      toolErrorsTotal: registry.counter({
        name: "agent_tool_errors_total",
        help: "Tool execution errors by tool name",
        labelNames: TOOL_LABELS,
      }),
    };
  }

  private static buildChainMetrics(registry: MetricsRegistry) {
    return {
      chainHops: registry.histogram({
        name: "agent_chain_hops",
        help: "Dispatch chain hop count per chain",
        buckets: [1, 2, 3, 5, 8, 13, 20, 50, 100],
      }),
      chainDepthExceededTotal: registry.counter({
        name: "agent_chain_depth_exceeded_total",
        help: "Dispatch chains that hit max depth",
      }),
      noYieldWithOrphanTextTotal: registry.counter({
        name: "agent_no_yield_orphan_text_total",
        help: "No-yield retries where LLM output direct text but never called speak (orphan text detection)",
        labelNames: ["otter_id"],
      }),
    };
  }

  /**
   * 记录一次 invoke attempt 的完整退出画像（唯一入口，保证 outcome 计数不重不漏）。
   * tokenUsage 为 session 累计值，此处差分为 attempt 增量。
   */
  recordInvoke(p: InvokeOutcomeRecord): void {
    this.invokeTotal.inc({
      model: p.model, otter_type: p.otterType, source: p.source, outcome: p.outcome, retry: p.retry,
    });
    this.invokeDuration.observe({ model: p.model, otter_type: p.otterType, outcome: p.outcome }, p.durationMs);

    if (p.tokenUsage) {
      const last = this.lastTokenSnapshot.get(p.otterId);
      /** cur < last：session 重置/重建，累计值回落，取全量 */
      const dInput = last && p.tokenUsage.input >= last.input ? p.tokenUsage.input - last.input : p.tokenUsage.input;
      const dOutput = last && p.tokenUsage.output >= last.output ? p.tokenUsage.output - last.output : p.tokenUsage.output;
      if (dInput > 0) this.tokenInput.inc({ model: p.model, otter_type: p.otterType }, dInput);
      if (dOutput > 0) this.tokenOutput.inc({ model: p.model, otter_type: p.otterType }, dOutput);
      this.lastTokenSnapshot.set(p.otterId, { input: p.tokenUsage.input, output: p.tokenUsage.output });
    }

    if (p.ctxTokens !== undefined) {
      this.contextTokens.observe({ model: p.model, otter_type: p.otterType }, p.ctxTokens);
    }
    if (p.firstByteLatencyMs !== undefined) {
      this.firstByteLatency.observe({ model: p.model }, p.firstByteLatencyMs);
    }
  }

  recordRetry(kind: RetryKind): void {
    this.retryTotal.inc({ kind });
  }

  recordGuardAbort(model: string, reason: string): void {
    this.guardAbortTotal.inc({ model, reason: normalizeGuardReason(reason) });
  }

  recordToolCall(tool: string): void {
    this.toolCallsTotal.inc({ tool });
  }

  recordToolDuration(tool: string, durationMs: number): void {
    this.toolDuration.observe({ tool }, durationMs);
  }

  recordToolError(tool: string): void {
    this.toolErrorsTotal.inc({ tool });
  }

  recordCompaction(reason: string, aborted: boolean): void {
    this.compactionTotal.inc({ reason: reason || "unknown", aborted: String(aborted) });
  }

  recordSessionRebuild(): void {
    this.sessionRebuildTotal.inc();
  }

  recordChainHops(count: number): void {
    this.chainHops.observe(count);
  }

  recordChainDepthExceeded(): void {
    this.chainDepthExceededTotal.inc();
  }

  /** F20260821spcm: 旁白流失计数（按 otterId 分组） */
  recordNoYieldWithOrphanText(otterId: string): void {
    this.noYieldWithOrphanTextTotal.inc({ otter_id: otterId });
  }
}
