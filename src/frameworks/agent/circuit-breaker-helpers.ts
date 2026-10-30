/**
 * 熔断器相关的辅助函数
 */

import { ToolCallCircuitBreaker, buildToolSignature } from "./tool-call-circuit-breaker";
import type { CircuitBreakerConfig } from "./tool-call-circuit-breaker";
import type { Logger } from "@usecases/ports/logger";
import { getContextWindowTokens, getLastStopReason } from "./context-tokens";
import type { ModelPool } from "@frameworks/llm/model-pool";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { Model, Api } from "@earendil-works/pi-ai";
import { getConfig } from "@frameworks/config";
import type { OutputGuardConfig } from "./output-guard";
import { attachOutputGuard } from "./output-guard";
import { otterInvokeStorage } from "./model-runtime-registry";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { diffTokenUsage, type TokenUsage } from "@usecases/conversation/token-usage";


/** _attachGuards 所需的参数类型 */
export interface AttachGuardsParams {
  session: { subscribe: (fn: (event: unknown) => void) => () => void; abort: () => Promise<void> };
  sessionKey: string;
  otterId: string;
  activeSessions: Map<string, { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string }>;
  circuitBreakerConfig: CircuitBreakerConfig;
  logger: Logger;
  /** F20260821i336：编排守卫检查函数（可选） */
  orchestrationCheck?: (toolName: string, args?: unknown) => string | null;
  /** F20261029gblkv（guard-v4）：原守卫传参族（projectRoot/sessionCwd/sandboxGuarded/
   *  onGuardIntercept/guardGateActive）已退役——bash 守卫唯一执行点迁 tool_call 门
   *  （model-runtime-registry bashGuardGate 直读 store），本链不再涉守卫。 */
  /** F20261020hlbk（#1556）→ F20261027cbfp（#1653）：per-invoke 循环硬熔断标记（签名→理由）。
   *  写入时机（两条件或）：terminate（strike 涨满）/ repeatOffender（同签名第 2 次 steer，复犯）。
   *  首次 steer 不写（纯警告）；tool_call 门（loopBlockGuard）读到即物理阻断该签名后续调用。 */
  loopBlockedTools?: Map<string, string>;
}

/** _attachGuards 返回类型 */
export interface AttachGuardsResult {
  activeEntry: { abort: () => Promise<void>; toolCallCount: number; guardAbortReason?: string } | undefined;
  circuitBreaker: ToolCallCircuitBreaker;
  unregisterToolCall: (() => void) | undefined;
  outputGuard: { getMetadata: () => { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number }; armFirstByteTimer: (guardAbort: () => void) => void };
  cleanupOutputGuard: () => void;
  armFirstByte: () => void;
}

/** attachGuards：熔断器 + 输出退化检测 */
export function attachGuards(params: AttachGuardsParams): AttachGuardsResult {
  const { session, sessionKey, otterId, activeSessions, circuitBreakerConfig, logger } = params;
  const activeEntry = activeSessions.get(sessionKey);
  const timerRef: { clear: (toolCallId?: string) => void } = { clear: () => {} };
  const wrappedAbort = (reason?: string) => { timerRef.clear(); if (activeEntry && !activeEntry.guardAbortReason) activeEntry.guardAbortReason = reason ?? "internal_abort"; return session.abort(); };
  // #1674：tool_call 首次送达 halt 时接上既有 abort 收尾。
  // 处理器内只同步发出 abort 信号，不等待 session.abort() 的 waitForIdle Promise（防自等待）。
  // 不在 prompt 前预触发：attachGuards 早于 session.prompt()，此刻 abort 是 no-op，
  // 且会提前置幂等标记吞掉后续真实 block 的终止请求。
  const invokeStore = otterInvokeStorage.getStore();
  if (invokeStore) invokeStore.requestHaltAbort = () => {
    void wrappedAbort('halt').catch((err: unknown) => {
      logger.warn(`[halt] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const { circuitBreaker, unregisterToolCall, clearEventTimer } = attachCircuitBreaker(session, otterId, circuitBreakerConfig, logger, { abortOverride: wrappedAbort, orchestrationCheck: params.orchestrationCheck, loopBlockedTools: params.loopBlockedTools });
  timerRef.clear = clearEventTimer;
  /** F20260804dglp：outputGuard 配置含 detector 参数与首字节超时；显式过滤 undefined 防覆盖默认值 */
  const cb = getConfig().circuitBreaker;
  const cfg: Partial<OutputGuardConfig> = {
    ...cb?.outputGuard,
    ...(cb?.streamingTimeoutMs !== undefined && { streamingTimeoutMs: cb.streamingTimeoutMs }),
    ...(cb?.firstByteTimeoutMs !== undefined && { firstByteTimeoutMs: cb.firstByteTimeoutMs }),
  };
  /** abort 返回 Promise：fire 路径无人 await，catch 防 unhandledRejection */
  const guardAbort = () => {
    void wrappedAbort(outputGuard.getMetadata().reason).catch((err: unknown) => {
      logger.warn(`[output-guard] abort 调用失败 otter=${otterId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const { guard: outputGuard, cleanup: cleanupOutputGuard } = attachOutputGuard(session, otterId, cfg, logger, guardAbort);
  const armFirstByte = () => outputGuard.armFirstByteTimer(guardAbort);
  return { activeEntry, circuitBreaker, unregisterToolCall, outputGuard, cleanupOutputGuard, armFirstByte };
}

/** _buildInvokeResult 所需的参数类型 */
export interface BuildInvokeResultParams {
  otterId: string;
  session: { getSessionStats: () => { tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }; sessionManager: { getBranch: () => SessionEntry[] } };
  circuitBreaker: ToolCallCircuitBreaker;
  modelPool?: ModelPool;
  otterConfigProvider: OtterConfigProvider;
  model: Model<Api>;
  logger: Logger;
  getModelAliasForLog: (otterId: string) => string;
  tokenUsageBefore?: TokenUsage;
}

/** _buildInvokeResult 返回类型 */
export interface BuildInvokeResultResult {
  text: string;
  tokenUsageDelta?: TokenUsage;
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  ctxTokens?: number;
  ctxMax?: number;
  circuitBreakerMetadata?: { totalCalls: number; circuitReason?: string };
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
  modelAlias?: string;
  _selfRestart?: { otterId: string; summary?: string; modelAlias?: string; synthesizePast?: boolean };
  /** LLM 直出文本（未通过 speak 输出，对其他人不可见）。用于检测"旁白流失"失败形态 */
  directText?: string;
  /** 末条 assistant 消息的 stopReason（F20260903lngth：length=生成被 token 上限截断）。
   *  Pi SDK 对 length-stop 摘要 fail-closed（compaction.js getSummarizationFailure），
   *  本字段把截断信号带上结果边界，供合成链路做同样的完整性校验 */
  lastStopReason?: string;
}

/** buildInvokeResult：构建 invoke 结果 */
export function buildInvokeResult(params: BuildInvokeResultParams): BuildInvokeResultResult {
  const { otterId, session, circuitBreaker, modelPool, otterConfigProvider, model, getModelAliasForLog, tokenUsageBefore } = params;
  const stats = session.getSessionStats();
  /** F20260923icus（#1149）：cache token 随快照透传——SDK SessionStats.tokens 本含四字段，
   *  此前只取 input/output 致 cache 数据在 invoke 落库链上丢失（健康面板 invoke 均值口径缺 cache）。 */
  const tokenUsage = { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite };

  /** F20260808ctxw：上下文窗口占用 = 末次有效 assistant 消息的 usage（input+output+cacheRead+cacheWrite），
   * 与 SDK compaction 判定同公式、同 compaction 边界语义；session 重建/compaction 后自然回落，不会虚增 */
  const ctxTokens = getContextWindowTokens(session.sessionManager.getBranch());

  // per-otter contextWindow
  let ctxMax: number | undefined;
  if (modelPool) {
    const otterConfig = otterConfigProvider.getConfig(otterId);
    ctxMax = modelPool.getContextWindow(otterConfig?.modelAlias);
  } else {
    ctxMax = model.contextWindow;
  }
  const result: BuildInvokeResultResult = buildResult("", tokenUsage, circuitBreaker, ctxMax, ctxTokens);
  if (tokenUsageBefore) result.tokenUsageDelta = diffTokenUsage(tokenUsageBefore, tokenUsage);
  /** F20260814mtrc：模型别名随结果透传（metrics model label 数据源） */
  result.modelAlias = getModelAliasForLog(otterId);
  /** F20260903lngth：截断信号透传——length-stop 不抛错，不带上边界则下游无法感知 */
  result.lastStopReason = getLastStopReason(session.sessionManager.getBranch());
  return result;
}

/** checkSessionError：检查 session 是否记录了 LLM API 错误 */
export function checkSessionError(session: { state: { errorMessage?: string } }, otterId: string, logger: Logger): void {
  const errorMessage = session.state.errorMessage;
  if (errorMessage) {
    logger.error('LLM API error detected after prompt', undefined, { otterId, errorMessage });
    throw new Error(`LLM API error: ${errorMessage}`);
  }
}

/** buildPromptResult 所需的参数类型 */
export interface BuildPromptResultParams {
  otterId: string;
  session: { getSessionStats: () => { tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }; sessionManager: { getBranch: () => SessionEntry[] } };
  circuitBreaker: ToolCallCircuitBreaker;
  outputGuard: { getMetadata: () => { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number } };
  activeEntry: { guardAbortReason?: string } | undefined;
  modelPool: ModelPool | undefined;
  otterConfigProvider: OtterConfigProvider;
  model: Model<Api>;
  logger: Logger;
  getModelAliasForLog: (otterId: string) => string;
  tokenUsageBefore?: TokenUsage;
}

/** buildPromptResult：prompt 成功后的结果组装 + 首字节延迟埋点日志 */
export function buildPromptResult(params: BuildPromptResultParams): BuildInvokeResultResult {
  const { otterId, session, circuitBreaker, outputGuard, activeEntry, modelPool, otterConfigProvider, model, logger, getModelAliasForLog, tokenUsageBefore } = params;
  const result = buildInvokeResult({ otterId, session, circuitBreaker, modelPool, otterConfigProvider, model, logger, getModelAliasForLog, tokenUsageBefore });
  const guardMeta = outputGuard.getMetadata();
  result.outputGuardMetadata = guardMeta;
  if (guardMeta.firstByteLatencyMs !== undefined) {
    logger.info('LLM first-byte latency', { otterId, firstByteLatencyMs: guardMeta.firstByteLatencyMs });
  }
  if (activeEntry?.guardAbortReason) (result as unknown as Record<string, unknown>)._guardAbortReason = activeEntry.guardAbortReason;
  return result;
}

/** 熔断器 tool_execution_start 钩子 */
// eslint-disable-next-line max-lines-per-function
export function attachCircuitBreaker(
  session: { subscribe: (fn: (event: unknown) => void) => () => void; steer?: (text: string) => Promise<void>; abort: () => Promise<void> },
  otterId: string,
  circuitBreakerConfig: CircuitBreakerConfig,
  logger: Logger,
  options?: { abortOverride?: (reason?: string) => void; orchestrationCheck?: (toolName: string, args?: unknown) => string | null; loopBlockedTools?: Map<string, string> },
): { circuitBreaker: ToolCallCircuitBreaker; unregisterToolCall: (() => void) | undefined; clearEventTimer: (toolCallId?: string) => void } {
  const circuitBreaker = new ToolCallCircuitBreaker(circuitBreakerConfig, otterId, logger);
  const doAbort = options?.abortOverride ?? (() => { session.abort(); });

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
  // eslint-disable-next-line complexity, max-statements
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
      // F20261020hlbk（#1566）→ F20261027cbfp（#1653 P0-2 + S1 补防）：黑名单写入两条件（或）——
      // ① terminate：strike 涨满，写入 + abort；
      // ② repeatOffender：同签名第 2 次 steer（复犯，首次警告未生效）——仅写不 abort（本次仍
      //   steer 提醒，后续同签名由门物理拦截）。
      // 原 #1566 实现 steer 首次即写：滑窗误报一次 → 签名永久拉黑 → 一次误判放大为会话级
      // 持续瘫痪（#1653 案发：239 次门拦截重灾）。S1 检视实证：仅 terminate 写入时，
      // B-3 连发+变调穿插类复犯可借穿插 allow 洗掉 strike、滑窗多重集永不命中，terminate
      // 数学上不可达（780 次 0 terminate）——复犯标记补回 #1556「复又发作」防线。
      // 首次 steer 不写（纯警告，误伤优先）；speak/yield 豁免（报告+交棒是唯一逃生口）。
      const shouldBlacklist =
        toolName !== "speak" && toolName !== "yield" &&
        (result.action === "terminate" || result.repeatOffender === true);
      if (shouldBlacklist) {
        options?.loopBlockedTools?.set(buildToolSignature(toolName, e.args), result.reason ?? "循环重复调用");
      }
      if (result.action === "terminate") {
        // terminate 时清除所有计时器（避免其他并行工具的计时器在 abort 后继续运行）
        clearEventTimer();
        doAbort(`circuit_break:${result.trigger ?? "unknown"}`);
        return;
      }
      if (result.action === "steer") {
        if (toolName !== "speak") session.steer?.(result.reason ?? "Stop calling tools. Call speak now."); // F20260806cbsx: speak 是回合出口，对其 steer 有害无益
        return;
      }

      // F20260821i336：编排对话软守卫——熔断器检查通过后，检查编排守卫条件
      if (options?.orchestrationCheck && toolName !== "speak") {
        const orchestrationWarning = options.orchestrationCheck(toolName, e.args);
        if (orchestrationWarning) {
          session.steer?.(orchestrationWarning);
          return;
        }
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

  /** token 超阈值警告已删（F20260904cq30）：1278 次日志零下游消费的假水位线。
   *  上下文水位域唯一真相源 = 交接触发线（llm.models[].handoffThresholdTokens，
   *  F20260920uhuc 需求变更 2026-09-20：按模型直给，旧 contextQuality.compactionReserveTokens 退役）；
   *  水位数据每消息落 DB（messages.context_tokens），观测走 DB/metrics 不走日志。 */

/** 构建执行结果（含熔断器元数据） */
export function buildResult(
  text: string,
  tokenUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  circuitBreaker?: ToolCallCircuitBreaker,
  ctxMax?: number,
  ctxTokens?: number,
) {
  return {
    text,
    tokenUsage: tokenUsage
      ? { input: tokenUsage.input, output: tokenUsage.output, cacheRead: tokenUsage.cacheRead, cacheWrite: tokenUsage.cacheWrite }
      : undefined,
    ctxTokens,
    ctxMax,
    circuitBreakerMetadata: circuitBreaker?.getMetadata(),
  };
}
