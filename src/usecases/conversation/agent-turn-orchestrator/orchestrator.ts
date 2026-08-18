/**
 * AgentTurnOrchestrator - 发言轮编排（usecase 层）
 *
 * Why: 从 AgentInvoker 上提编排逻辑，实现编排与 SDK 调用分离。
 * orchestrator 负责：退出分类、重试决策、终态防护、metrics 埋点。
 * adapter（AgentInvoker）负责：SDK 调用、SSE 事件映射、消息生命周期。
 *
 * 反强编排原则：attemptDriver 回调仅限"重执行当前轮"，
 * 接口注释显式声明防扩写成流程引擎。
 */

import type { AgentMetricsPort, InvokeOutcomeRecord } from "@usecases/ports/agent-metrics-port";
import type { Logger } from "@usecases/ports/logger";
import { toRetryLabel } from "@usecases/ports/agent-metrics-port";
import { getTraceContext } from "@usecases/ports/trace-context";
import type { ExitReason } from "./exit-classifier";
import { classifyExit, exitKindToOutcome } from "./exit-classifier";
import { isRetryableGuardAbort, buildRetryFailBody, buildGuardAbortBody, buildUserAbortBody, buildSpeakRetryMsg } from "./retry-policy";
import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { ErrorWithToolCallCount, InvokeResultShape, TurnInput, TurnResult, AttemptDriver, TurnCallbacks, RouteContext, RetryContext, TerminalContext } from "./types";

export class AgentTurnOrchestrator {
  /** Messages already sent to a terminal state (abort/fail), prevents double-terminal */
  private readonly terminalMessages = new Set<string>();
  /**
   * 已记录 metrics 的 attempt 键（messageId:retryCount）。
   * 防御 routeByReason 抛错 → 外层 catch 重入 classifyAndRoute 的双计。
   */
  private readonly recordedAttempts = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly metrics?: AgentMetricsPort,
  ) {}

  /**
   * 执行一轮发言：分类退出、按策略重试、守护终态。
   *
   * 核心循环：invoke → classify → route（可能重试 → 再 invoke）。
   * 递归重入改为循环 + driver.invoke，避免栈溢出。
   */
  async executeTurn(
    input: TurnInput,
    driver: AttemptDriver,
    callbacks: TurnCallbacks,
  ): Promise<TurnResult> {
    const startTime = Date.now();
    let currentInput = input;

    // 主循环：重试时更新 currentInput 继续
    while (true) {
      const attemptStartTime = Date.now();
      let result: InvokeResultShape;
      let toolCallCount: number;

      try {
        const attempt = await driver.invoke(currentInput, (event) => {
          this.recordStreamEventMetrics(event, callbacks);
        });
        result = attempt.result;
        toolCallCount = attempt.toolCallCount;
      } catch (err) {
        result = { text: '' };
        toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? 0;
      }

      // Speaking guard: content delivery takes priority
      const speakingResult = await this.tryCompleteSpeaking(
        currentInput, result, callbacks, startTime, attemptStartTime,
      );
      if (speakingResult) return speakingResult;

      // Classify exit reason
      const reason = classifyExit(
        { messageId: currentInput.messageId, result, err: undefined, toolCallCount },
        new Set<string>(),
        (id) => driver.getInternalAbortReason(id) ?? undefined,
      );

      // Record failed attempt
      this.recordFailedAttempt(reason, currentInput, result, callbacks, attemptStartTime);

      // Route by reason
      const routeCtx: RouteContext = {
        input: currentInput,
        result,
        toolCallCount,
        driver,
        callbacks,
        startTime,
      };
      const routeResult = await this.routeByReason(reason, routeCtx);

      if (routeResult) return routeResult;

      // If routeByReason returns null, retry with updated input
      currentInput = {
        ...currentInput,
        retryCount: 1,
        userMessageContent: buildSpeakRetryMsg(toolCallCount),
      };
    }
  }

  /** Try to complete a speaking message */
  private async tryCompleteSpeaking(
    input: TurnInput,
    result: InvokeResultShape,
    callbacks: TurnCallbacks,
    startTime: number,
    attemptStartTime: number,
  ): Promise<TurnResult | undefined> {
    const msg = await callbacks.getMessageById(input.messageId);
    if (msg?.status !== 'speaking') return undefined;

    try {
      const cr = await callbacks.completeMessage(input.messageId, {
        contextTokens: result.ctxTokens,
        contextTokensMax: result.ctxMax,
      });

      void this.recordAttempt({
        messageId: input.messageId,
        otterId: input.otterId,
        result,
        outcome: 'success',
        retryCount: input.retryCount,
        manualRetry: input.manualRetry,
        startTime: attemptStartTime,
      }, callbacks);

      this.logger.info('Agent invocation completed', {
        otterId: input.otterId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        duration: Date.now() - startTime,
        tokenUsage: result.tokenUsage,
        status: 'success',
      });

      return {
        messageId: input.messageId,
        duration: Date.now() - startTime,
        tokenUsage: result.tokenUsage,
        aggregatedTargets: cr.turnClose?.aggregatedTargets,
      };
    } catch {
      return undefined;
    }
  }

  /** Route by classified exit reason */
  private async routeByReason(
    reason: ExitReason,
    ctx: RouteContext,
  ): Promise<TurnResult | null> {
    switch (reason.kind) {
      case 'user_abort':
        return this.handleUserAbort(ctx);
      case 'guard_abort':
        return this.routeGuardAbort(reason, ctx);
      case 'api_error':
        return this.failTerminal(ctx.input, reason.errorMessage, ctx.callbacks, ctx.startTime);
      case 'no_speak':
        return this.handleSpeakRetry(ctx);
      default:
        return { messageId: ctx.input.messageId, duration: Date.now() - ctx.startTime };
    }
  }

  /** Handle user abort: speaking guard → abort terminal */
  private async handleUserAbort(ctx: RouteContext): Promise<TurnResult> {
    const msg = await ctx.callbacks.getMessageById(ctx.input.messageId);
    if (msg?.status === 'speaking') {
      try {
        await ctx.callbacks.completeMessage(ctx.input.messageId);
        return { messageId: ctx.input.messageId, duration: Date.now() - ctx.startTime };
      } catch {
        // Fall through to abort
      }
    }

    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'user' });
  }

  /** Route guard abort: degenerate retry → auto-retry → abort terminal */
  private async routeGuardAbort(
    reason: ExitReason & { kind: 'guard_abort' },
    ctx: RouteContext,
  ): Promise<TurnResult | null> {
    const { guardReason } = reason;
    const { retryCount } = ctx.input;

    if (guardReason === 'degenerate_output' && retryCount === 0) {
      return this.handleDegenerateRetry(ctx);
    }

    if (retryCount === 0 && isRetryableGuardAbort(guardReason)) {
      this.logger.info('Auto-retry on guard abort', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        guardReason,
      });
      return this.handleAutoRetry(ctx, guardReason);
    }

    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason });
  }

  /** Handle degenerate retry: abort + system reminder + retry */
  private async handleDegenerateRetry(ctx: RouteContext): Promise<TurnResult | null> {
    this.logger.info('Degenerate output retry triggered', {
      messageId: ctx.input.messageId,
      otterId: ctx.input.otterId,
    });

    const failBody = "[系统] 检测到输出异常重复，正在自我纠正";
    try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    ctx.callbacks.emitEvent({
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName: otter?.name ?? ctx.input.otterId, body: failBody },
    });

    const retryMsg = "[系统提醒] 你上一轮陷入重复循环，分析已在上下文中，不要重新推理，直接基于已有结论调用 speak 输出。";
    let sysMsg;
    try {
      sysMsg = await ctx.callbacks.sendSystem(ctx.input.conversationId, retryMsg);
      ctx.callbacks.emitEvent({
        event: "system.message",
        data: { messageId: sysMsg.id, content: sysMsg.body, seq: sysMsg.sequenceNum },
      });
    } catch (err) {
      this.logger.warn('sendSystem failed during retry, falling back to abort', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }

    return null;
  }

  /** Handle auto-retry: fail + re-invoke */
  private async handleAutoRetry(ctx: RouteContext, reason: string): Promise<TurnResult | null> {
    const failBody = `[系统] ${buildRetryFailBody(reason)}, 正在自动重试`;

    try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    ctx.callbacks.emitEvent({
      event: 'message.failed',
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName: otter?.name ?? ctx.input.otterId, body: failBody },
    });

    return null;
  }

  /** Handle speak retry: fail + system reminder + retry */
  private async handleSpeakRetry(ctx: RouteContext): Promise<TurnResult | null> {
    if (ctx.input.retryCount === 0) {
      const failBody = "[系统] 未调用 speak 工具结束发言";
      try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

      try {
        await ctx.callbacks.prepareForRetry(ctx.input.messageId);
      } catch (err) {
        this.logger.warn('prepareForRetry failed, falling back to legacy retry', {
          messageId: ctx.input.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        return this.executeRetryWithSystemReminder({
          input: ctx.input,
          failBody,
          retryMsg: buildSpeakRetryMsg(ctx.toolCallCount),
          tokenUsage: ctx.result.tokenUsage,
          callbacks: ctx.callbacks,
          startTime: ctx.startTime,
        });
      }

      return null;
    }

    this.logger.warn('Speak retry exhausted, failing message', {
      messageId: ctx.input.messageId,
      otterId: ctx.input.otterId,
      conversationId: ctx.input.conversationId,
    });

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    const otterName = otter?.name ?? ctx.input.otterId;
    const failBody = "[系统] 重试后仍未调用 speak 工具";

    try {
      await ctx.callbacks.failMessage(ctx.input.messageId, failBody, [ctx.input.senderId]);
    } catch { /* ignore */ }

    ctx.callbacks.emitEvent({
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName, body: failBody },
    });

    return {
      messageId: ctx.input.messageId,
      duration: Date.now() - ctx.startTime,
      tokenUsage: ctx.result.tokenUsage,
    };
  }

  /** Execute retry with system reminder (legacy path) */
  private async executeRetryWithSystemReminder(ctx: RetryContext): Promise<TurnResult | null> {
    try { await ctx.callbacks.failMessage(ctx.input.messageId, ctx.failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    const otterName = otter?.name ?? ctx.input.otterId;
    ctx.callbacks.emitEvent({
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName, body: ctx.failBody },
    });

    let sysMsg;
    try {
      sysMsg = await ctx.callbacks.sendSystem(ctx.input.conversationId, ctx.retryMsg);
      ctx.callbacks.emitEvent({
        event: "system.message",
        data: { messageId: sysMsg.id, content: sysMsg.body, seq: sysMsg.sequenceNum },
      });
    } catch (err) {
      this.logger.warn('sendSystem failed during retry, falling back to abort', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.abortTerminal({
        input: ctx.input,
        toolCallCount: 0,
        callbacks: ctx.callbacks,
        startTime: ctx.startTime,
        kind: 'guard',
        guardReason: 'degenerate_output',
      });
    }

    return null;
  }

  /** Abort terminal: build body → sendMessage.abort → emit message.aborted */
  private async abortTerminal(ctx: TerminalContext): Promise<TurnResult> {
    const { messageId, otterId } = ctx.input;

    if (this.terminalMessages.has(messageId)) {
      return { messageId, duration: Date.now() - ctx.startTime };
    }

    this.terminalMessages.add(messageId);

    const actualToolCallCount = ctx.toolCallCount || 0;
    const body = ctx.kind === 'guard'
      ? buildGuardAbortBody(ctx.guardReason)
      : buildUserAbortBody(actualToolCallCount, await ctx.callbacks.getPartnerLabel());

    try {
      await ctx.callbacks.abortMessage(messageId, {
        body,
        talkingStonePassedTo: ctx.input.senderId ? [ctx.input.senderId] : [],
      });
    } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(otterId);
    ctx.callbacks.emitEvent({
      event: 'message.aborted',
      data: { messageId, body, otterId, otterName: otter?.name },
    });

    return { messageId, duration: Date.now() - ctx.startTime };
  }

  /** Fail terminal: sendMessage.fail → emit error */
  private async failTerminal(
    input: TurnInput,
    errorMessage: string,
    callbacks: TurnCallbacks,
    startTime: number,
  ): Promise<TurnResult> {
    const { messageId, otterId } = input;

    if (this.terminalMessages.has(messageId)) {
      return { messageId, duration: Date.now() - startTime };
    }

    this.terminalMessages.add(messageId);

    try {
      await callbacks.failMessage(messageId, `[错误] ${errorMessage}`);
    } catch { /* ignore */ }

    callbacks.emitEvent({
      event: 'error',
      data: { message: errorMessage, messageId, otterId },
    });

    return { messageId, duration: Date.now() - startTime };
  }

  /** F20260814mtrc：流事件埋点 */
  private recordStreamEventMetrics(e: AgentStreamEvent, callbacks: TurnCallbacks): void {
    if (!callbacks.metrics) return;
    try {
      switch (e.type) {
        case "tool_execution_start":
          callbacks.metrics.recordToolCall(String(e.name ?? e.toolName ?? "unknown"));
          break;
        case "auto_retry_start":
          callbacks.metrics.recordRetry("sdk_auto");
          break;
        case "compaction_end":
          callbacks.metrics.recordCompaction(String(e.reason ?? ""), e.aborted === true);
          break;
        default:
          break;
      }
    } catch (err) {
      callbacks.logger.warn('stream event metrics failed (non-fatal)', {
        eventType: e.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** attempt 记录去重键 */
  private attemptKey(messageId: string, retryCount: number): string {
    return `${messageId}:${retryCount}`;
  }

  /** 记录一次 attempt 的 metrics */
  private async recordAttempt(
    p: {
      messageId: string;
      otterId: string;
      result?: InvokeResultShape;
      err?: unknown;
      outcome: string;
      retryCount: number;
      manualRetry: boolean;
      startTime: number;
    },
    callbacks: TurnCallbacks,
  ): Promise<void> {
    if (!callbacks.metrics) return;
    const key = this.attemptKey(p.messageId, p.retryCount);
    if (this.recordedAttempts.has(key)) return;
    this.recordedAttempts.add(key);

    try {
      const otter = await callbacks.getOtterById(p.otterId);
      const record = this.buildInvokeRecord(p, otter?.type);

      if (p.result?.sessionRebuilt) callbacks.metrics.recordSessionRebuild();
      callbacks.metrics.recordInvoke(record);
    } catch (err) {
      callbacks.logger.warn('metrics recording failed (non-fatal)', {
        otterId: p.otterId,
        outcome: p.outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 组装 attempt 记录 */
  private buildInvokeRecord(
    p: { otterId: string; result?: InvokeResultShape; err?: unknown; outcome: string; retryCount: number; manualRetry: boolean; startTime: number },
    otterType?: string,
  ): InvokeOutcomeRecord {
    const errMeta = p.err as ErrorWithToolCallCount | undefined;
    const model = p.result?.modelAlias ?? errMeta?._modelAlias ?? "unknown";
    const firstByteLatencyMs = this.getFirstByteLatency(p.result, errMeta);

    return {
      otterId: p.otterId,
      model,
      otterType: otterType ?? "unknown",
      source: getTraceContext().source ?? "direct",
      outcome: p.outcome as InvokeOutcomeRecord["outcome"],
      retry: toRetryLabel(p.retryCount, p.manualRetry),
      durationMs: Date.now() - p.startTime,
      tokenUsage: p.result?.tokenUsage,
      ctxTokens: p.result?.ctxTokens,
      firstByteLatencyMs,
    };
  }

  /** 获取首字节延迟 */
  private getFirstByteLatency(result?: InvokeResultShape, errMeta?: ErrorWithToolCallCount): number | undefined {
    return result?.outputGuardMetadata?.firstByteLatencyMs
      ?? errMeta?._outputGuardMetadata?.firstByteLatencyMs;
  }

  /** 失败 attempt 记录 */
  private recordFailedAttempt(
    reason: ExitReason,
    input: TurnInput,
    result: InvokeResultShape | undefined,
    callbacks: TurnCallbacks,
    attemptStartTime: number,
  ): void {
    if (!callbacks.metrics) return;
    if (this.recordedAttempts.has(this.attemptKey(input.messageId, input.retryCount))) return;

    if (reason.kind === 'guard_abort') {
      try {
        callbacks.metrics.recordGuardAbort(
          result?.modelAlias ?? "unknown",
          reason.guardReason,
        );
      } catch (err) {
        callbacks.logger.warn('metrics recordGuardAbort failed (non-fatal)', {
          reason: reason.guardReason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.recordRetryIntent(reason, input.retryCount, callbacks);

    void this.recordAttempt({
      messageId: input.messageId,
      otterId: input.otterId,
      result,
      outcome: exitKindToOutcome(reason.kind, input.retryCount),
      retryCount: input.retryCount,
      manualRetry: input.manualRetry,
      startTime: attemptStartTime,
    }, callbacks);
  }

  /** 重试意图计数 */
  private recordRetryIntent(
    reason: ExitReason,
    retryCount: number,
    callbacks: TurnCallbacks,
  ): void {
    if (retryCount !== 0) return;

    const recordRetrySafe = (kind: string) => {
      if (!callbacks.metrics) return;
      try {
        callbacks.metrics.recordRetry(kind as Parameters<AgentMetricsPort["recordRetry"]>[0]);
      } catch (err) {
        callbacks.logger.warn('metrics recordRetry failed (non-fatal)', {
          kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (reason.kind === 'no_speak') {
      recordRetrySafe("no_speak");
      return;
    }
    if (reason.kind !== 'guard_abort') return;
    if (reason.guardReason === 'degenerate_output') {
      recordRetrySafe("degenerate_output");
      return;
    }
    if (isRetryableGuardAbort(reason.guardReason)) {
      recordRetrySafe(reason.guardReason.startsWith("circuit_break:")
        ? "circuit_break"
        : reason.guardReason as "streaming_timeout" | "first_byte_timeout");
    }
  }

  /** 中断 Agent 生成 */
  requestAbort(otterId: string, messageId: string, driver: AttemptDriver): void {
    driver.abort(otterId, messageId);
  }
}
