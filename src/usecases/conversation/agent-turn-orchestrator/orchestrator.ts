/**
 * AgentTurnOrchestrator - 发言轮编排（usecase 层）
 *
 * Why: 从 AgentInvoker 上提编排逻辑，实现编排与 SDK 调用分离。
 * orchestrator 负责：退出分类、重试决策、终态防护、metrics 埋点。
 * adapter（AgentInvoker）负责：SDK 调用、SSE 事件映射、消息生命周期。
 *
 * 反强编排原则：attemptDriver 回调仅限“重执行当前轮”，
 * 接口注释显式声明防扩写成流程引擎。
 */
/* eslint-disable max-lines */ // Phase 2 orchestrator consolidates retry/abort/metrics logic; splitting prematurely would harm readability

import type { AgentMetricsPort, InvokeOutcomeRecord } from "@usecases/ports/agent-metrics-port";
import type { Logger } from "@usecases/ports/logger";
import { toRetryLabel } from "@usecases/ports/agent-metrics-port";
import { getTraceContext } from "@usecases/ports/trace-context";
import type { ExitReason } from "./exit-classifier";
import { classifyExit, exitKindToOutcome } from "./exit-classifier";
import { isRetryableGuardAbort, buildRetryFailBody, buildGuardAbortBody, buildUserAbortBody, buildYieldRetryMsg, buildCircuitBreakFailBody, buildCircuitBreakSystemMsg } from "./retry-policy";
import { aggregateBody } from "@entities/conversation/message";
import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { ErrorWithToolCallCount, InvokeResultShape, TurnInput, TurnResult, AttemptDriver, TurnCallbacks, RouteContext, RetryContext, TerminalContext, RetryWithNewMessageSignal } from "./types";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";

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

  /** Safe emitEvent wrapper - emitEvent is a user callback that can throw */
  private safeEmitEvent(callbacks: TurnCallbacks, event: { event: string; data: Record<string, unknown> }): void {
    try {
      callbacks.emitEvent(event);
    } catch {
      // Ignore SSE downstream failures - non-fatal
    }
  }

  /**
   * 执行一轮发言：分类退出、按策略重试、守护终态。
   *
   * 核心循环：invoke → classify → route（可能重试 → 再 invoke）。
   * 递归重入改为循环 + driver.invoke，避免栈溢出。
   */
  // eslint-disable-next-line max-lines-per-function, max-statements -- executeTurn is the core retry loop; splitting would obscure control flow
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
      let err: unknown;
      const attemptKey = this.attemptKey(currentInput.messageId, currentInput.retryCount);

      try {
        const attempt = await driver.invoke(currentInput, (event) => {
          this.recordStreamEventMetrics(event, callbacks);
        });
        result = attempt.result;
        toolCallCount = attempt.toolCallCount;
      } catch (e) {
        err = e;
        result = { text: '' };
        const errMeta = e as ErrorWithToolCallCount;
        toolCallCount = errMeta._toolCallCount ?? driver.getToolCallCount(currentInput.otterId, currentInput.messageId);
      } finally {
        // 清理当前 attempt 的去重键，防止内存泄漏
        this.recordedAttempts.delete(attemptKey);
      }

      // Speaking guard: content delivery takes priority (unless user aborted)
      const speakingResult = await this.tryCompleteSpeaking(
        currentInput, result, driver, { callbacks, startTime, attemptStartTime },
      );
      if (speakingResult) return speakingResult;

      // Classify exit reason
      const userAbortedSet = new Set<string>();
      if (driver.isUserAborted(currentInput.messageId)) {
        userAbortedSet.add(currentInput.messageId);
      }
      const reason = classifyExit(
        { messageId: currentInput.messageId, result, err, toolCallCount },
        userAbortedSet,
        (id) => driver.getInternalAbortReason(id) ?? undefined,
      );

      // F20260821spcm: 旁白流失检测——LLM 输出了直出文本但未调 speak
      const hasOrphanText = this.detectOrphanText(reason, result);

      // Record failed attempt
      this.recordFailedAttempt(reason, currentInput, result, err, { callbacks, attemptStartTime });
      if (hasOrphanText) {
        this.recordNoYieldWithOrphanText(currentInput.otterId, currentInput, callbacks);
        this.logger.info('Orphan text detected: LLM output direct text without calling speak', {
          messageId: currentInput.messageId,
          otterId: currentInput.otterId,
          orphanTextLength: result.directText?.trim().length ?? 0,
        });
      }

      // Route by reason
      const routeCtx: RouteContext = {
        input: currentInput,
        result,
        toolCallCount,
        driver,
        callbacks,
        startTime,
        hasOrphanText,
      };
      const routeResult = await this.routeByReason(reason, routeCtx);

      if (routeResult) {
        // Check if it's a retry-with-new-message signal
        if ('_retryWithNewMessage' in routeResult) {
          const retrySignal = routeResult as RetryWithNewMessageSignal;
          currentInput = {
            ...currentInput,
            messageId: retrySignal.newMessageId,
            retryCount: 1,
            userMessageContent: retrySignal.retryMsg,
            // F20260818cbkr：保留 retry 前首条消息 id（工作进度主要在此，熔断摘要合并取用）
            preRetryMessageId: currentInput.preRetryMessageId ?? currentInput.messageId,
          };
          continue;
        }
        return routeResult as TurnResult;
      }

      // If routeByReason returns null, retry with updated input (speak retry)
      currentInput = {
        ...currentInput,
        retryCount: 1,
        userMessageContent: buildYieldRetryMsg(toolCallCount, hasOrphanText),
      };
    }
  }

  /** Try to complete a speaking message */
  private async tryCompleteSpeaking(
    input: TurnInput,
    result: InvokeResultShape,
    driver: AttemptDriver,
    ctx: { callbacks: TurnCallbacks; startTime: number; attemptStartTime: number },
  ): Promise<TurnResult | undefined> {
    const msg = await ctx.callbacks.getMessageById(input.messageId);
    if (msg?.status !== 'speaking') return undefined;

    // If user has aborted, don't complete - let abort path handle it
    if (driver.isUserAborted(input.messageId)) return undefined;

    try {
      const cr = await ctx.callbacks.completeMessage(input.messageId, {
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
        startTime: ctx.attemptStartTime,
      }, ctx.callbacks);

      this.logger.info('Agent invocation completed', {
        otterId: input.otterId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        duration: Date.now() - ctx.startTime,
        tokenUsage: result.tokenUsage,
        status: 'success',
      });

      // 发送 message.complete 事件
      const duration = Date.now() - ctx.startTime;
      const otter = await ctx.callbacks.getOtterById(input.otterId);
      this.safeEmitEvent(ctx.callbacks, {
        event: "message.complete",
        data: {
          messageId: input.messageId,
          otterId: input.otterId,
          otterName: resolveSpeakerName("otter", input.otterId, otter?.name) ?? input.otterId,
          body: msg ? aggregateBody(msg.segments) : '',
          // F-multi-speak-bubble: 传递 segments 数组用于前端分段渲染
          segments: msg ? msg.segments.map(s => ({ id: s.id, body: s.body, sequenceNum: s.sequenceNum })) : [],
          turnId: msg?.turnId ?? '',
          duration: `${(duration / 1000).toFixed(1)}s`,
          ctx: result.ctxTokens,
          ctxMax: result.ctxMax,
        },
      });

      // 发送 turn.complete 事件
      this.safeEmitEvent(ctx.callbacks, { event: "turn.complete", data: {} });

      // 广播消息到 Web 和飞书
      await ctx.callbacks.broadcastMessage(input.messageId).catch(() => { /* non-fatal */ });

      return {
        messageId: input.messageId,
        duration,
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
  ): Promise<TurnResult | RetryWithNewMessageSignal | null> {
    switch (reason.kind) {
      case 'user_abort':
        return this.handleUserAbort(ctx);
      case 'guard_abort':
        return this.routeGuardAbort(reason, ctx);
      case 'api_error':
        return this.failTerminal(ctx.input, reason.errorMessage, ctx.callbacks, ctx.startTime);
      case 'no_yield':
        return this.handleYieldRetry(ctx);
      default:
        return { messageId: ctx.input.messageId, duration: Date.now() - ctx.startTime };
    }
  }

  /** Handle user abort: speaking guard → abort terminal */
  private async handleUserAbort(ctx: RouteContext): Promise<TurnResult> {
    const msg = await ctx.callbacks.getMessageById(ctx.input.messageId);
    if (msg?.status === 'speaking') {
      try {
        const cr = await ctx.callbacks.completeMessage(ctx.input.messageId);

        // 发送 message.complete 事件
        const duration = Date.now() - ctx.startTime;
        const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
        this.safeEmitEvent(ctx.callbacks, {
          event: "message.complete",
          data: {
            messageId: ctx.input.messageId,
            otterId: ctx.input.otterId,
            otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId,
            body: msg ? aggregateBody(msg.segments) : '',
            // F-multi-speak-bubble: 传递 segments 数组用于前端分段渲染
            segments: msg ? msg.segments.map(s => ({ id: s.id, body: s.body, sequenceNum: s.sequenceNum })) : [],
            turnId: msg?.turnId ?? '',
            duration: `${(duration / 1000).toFixed(1)}s`,
            ctx: ctx.result.ctxTokens,
            ctxMax: ctx.result.ctxMax,
          },
        });

        // 发送 turn.complete 事件
        this.safeEmitEvent(ctx.callbacks, { event: "turn.complete", data: {} });

        return { messageId: ctx.input.messageId, duration, aggregatedTargets: cr.turnClose?.aggregatedTargets };
      } catch {
        // Fall through to abort
      }
    }

    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'user' });
  }

  /** Route guard abort: degenerate retry → degenerate circuit break → auto-retry → abort terminal */
  private async routeGuardAbort(
    reason: ExitReason & { kind: 'guard_abort' },
    ctx: RouteContext,
  ): Promise<TurnResult | RetryWithNewMessageSignal | null> {
    const { guardReason } = reason;
    const { retryCount } = ctx.input;

    if (guardReason === 'degenerate_output') {
      await this.recordDegenerateHealingEvent(ctx);
    }

    if (guardReason === 'degenerate_output' && retryCount === 0) {
      return this.handleDegenerateRetry(ctx);
    }

    // F20260818cbkr：带污重试再次退化 → 熔断重启（上限判定在 handleCircuitBreak）
    if (guardReason === 'degenerate_output' && retryCount > 0) {
      return this.handleCircuitBreak(ctx);
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

  /** F20260818cbkr：degenerate guard 每次触发都落 healing_events（二级触发与观测的数据源，非致命） */
  private async recordDegenerateHealingEvent(ctx: RouteContext): Promise<void> {
    try {
      await ctx.callbacks.recordHealingEvent({
        messageId: ctx.input.messageId,
        conversationId: ctx.input.conversationId,
        otterId: ctx.input.otterId,
        errorType: "degenerate",
        severity: "high",
        description: `检测到输出异常重复（retry=${ctx.input.retryCount}）`,
        suggestion: "连续退化将触发熔断重启（F20260818cbkr）",
        context: { retryCount: ctx.input.retryCount, toolCallCount: ctx.toolCallCount },
      });
    } catch (err) {
      ctx.callbacks.logger.warn('degenerate healing event record failed (non-fatal)', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * F20260818cbkr 一级熔断：degenerate retry 本身再次退化。
   * 当前消息收尾为 failed + 熔断说明；熔断信号跨层上抛（executeTurn 不消费），
   * 由 agent-invoker 执行 restartSession + 写 circuit_break 事件 + 全新 invoke。
   */
  private async handleCircuitBreak(ctx: RouteContext): Promise<TurnResult> {
    // 熔断依赖 healing_events 状态载体（上限/二级判定）；不可用时降级为旧 abort 语义
    if (!ctx.callbacks.isCircuitBreakerEnabled()) {
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }

    this.logger.info('Circuit break triggered', {
      messageId: ctx.input.messageId,
      otterId: ctx.input.otterId,
      conversationId: ctx.input.conversationId,
    });

    // 熔断上限：当前 session 已由熔断创建，再退化说明非上下文污染问题 → 直接终态
    let circuitBreakCreated = false;
    try {
      circuitBreakCreated = await ctx.callbacks.isSessionCircuitBreakCreated(ctx.input.otterId);
    } catch (err) {
      ctx.callbacks.logger.warn('circuit break session check failed, treating as not created', {
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (circuitBreakCreated) {
      this.logger.warn('Circuit break limit reached, aborting', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
      });
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }

    const failBody = buildCircuitBreakFailBody();
    try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    this.safeEmitEvent(ctx.callbacks, {
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId, body: failBody },
    });

    /**
     * sendSystem 是通知性 IO——失败仅留痕,不放弃 restartSession(治疗动作)。
     * (不回退 abortTerminal:消息已 failed,再广播 aborted 会与熔断文案矛盾)
     */
    try {
      const sysMsg = await ctx.callbacks.sendSystem(ctx.input.conversationId, buildCircuitBreakSystemMsg());
      this.safeEmitEvent(ctx.callbacks, {
        event: "system.message",
        data: { messageId: sysMsg.id, content: sysMsg.body, seq: sysMsg.sequenceNum },
      });
    } catch (err) {
      this.logger.warn('sendSystem failed during circuit break (non-fatal, restart continues)', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      messageId: ctx.input.messageId,
      duration: Date.now() - ctx.startTime,
      _circuitBreak: {
        otterId: ctx.input.otterId,
        conversationId: ctx.input.conversationId,
        originalUserMessage: ctx.input.originalUserMessage,
        failedMessageId: ctx.input.messageId,
        firstMessageId: ctx.input.preRetryMessageId ?? ctx.input.messageId,
        toolCallCount: ctx.toolCallCount,
      },
    };
  }

  /** Handle degenerate retry: abort + system reminder + retry */
  private async handleDegenerateRetry(ctx: RouteContext): Promise<RetryWithNewMessageSignal | TurnResult> {
    this.logger.info('Degenerate output retry triggered', {
      messageId: ctx.input.messageId,
      otterId: ctx.input.otterId,
    });

    // F20260820d338：改进 failBody——避免 LLM 复述系统消息
    const failBody = "[系统保护] 输出内容异常重复，已中断并自动重试";
    try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    this.safeEmitEvent(ctx.callbacks, {
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId, body: failBody },
    });

    // F20260820d338：改进重试消息——避免 LLM 复述系统消息，给出具体指令
    const retryMsg =
      '[系统提醒] 你上一条消息的输出内容出现了重复循环（同一段文字被反复输出）。' +
      '上下文已包含之前的分析，不需要重新推理。' +
      '请直接调用 speak 工具输出一次结论，不要重复输出之前已经说过的内容。';
    let sysMsg;
    try {
      sysMsg = await ctx.callbacks.sendSystem(ctx.input.conversationId, retryMsg);
      this.safeEmitEvent(ctx.callbacks, {
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

    // Create new message for retry (degenerate retry uses new message)
    try {
      const newMsg = await ctx.callbacks.startNewMessage(
        ctx.input.conversationId,
        ctx.input.senderId,
        [ctx.input.senderId],
      );
      this.safeEmitEvent(ctx.callbacks, {
        event: "message.start",
        data: { messageId: newMsg.id, otterId: ctx.input.otterId, otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId, seq: newMsg.sequenceNum, createdAt: newMsg.createdAt },
      });

      // Update input with new message ID for retry
      return {
        _retryWithNewMessage: true as const,
        newMessageId: newMsg.id,
        retryMsg,
        toolCallCount: ctx.toolCallCount,
      } satisfies RetryWithNewMessageSignal;
    } catch (err) {
      this.logger.warn('startNewMessage failed during retry, falling back to abort', {
        messageId: ctx.input.messageId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }
  }

  /** Handle auto-retry: fail + re-invoke */
  private async handleAutoRetry(ctx: RouteContext, reason: string): Promise<TurnResult | null> {
    const failBody = `[系统] ${buildRetryFailBody(reason)}, 正在自动重试`;

    try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    this.safeEmitEvent(ctx.callbacks, {
      event: 'message.failed',
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId, body: failBody },
    });

    return null;
  }

  /** Handle yield retry: fail + system reminder + retry */
  private async handleYieldRetry(ctx: RouteContext): Promise<TurnResult | null> {
    if (ctx.input.retryCount === 0) {
      const failBody = "[系统] 未调用 yield 工具交回行动权";
      try { await ctx.callbacks.failMessage(ctx.input.messageId, failBody); } catch { /* ignore */ }

      try {
        // F20260821fix: no_yield 重试时保留 segments（speak 内容有效，不应被删除）
        await ctx.callbacks.prepareForRetry(ctx.input.messageId, true);
      } catch (err) {
        this.logger.warn('prepareForRetry failed, falling back to legacy retry', {
          messageId: ctx.input.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
        return this.executeRetryWithSystemReminder({
          input: ctx.input,
          failBody,
          retryMsg: buildYieldRetryMsg(ctx.toolCallCount, ctx.hasOrphanText),
          tokenUsage: ctx.result.tokenUsage,
          callbacks: ctx.callbacks,
          startTime: ctx.startTime,
        });
      }

      return null;
    }

    this.logger.warn('Yield retry exhausted, failing message', {
      messageId: ctx.input.messageId,
      otterId: ctx.input.otterId,
      conversationId: ctx.input.conversationId,
    });

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    const otterName = resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId;
    const failBody = "[系统] 重试后仍未调用 yield 工具";

    try {
      await ctx.callbacks.failMessage(ctx.input.messageId, failBody, [ctx.input.senderId]);
    } catch { /* ignore */ }

    this.safeEmitEvent(ctx.callbacks, {
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
    const otterName = resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId;
    this.safeEmitEvent(ctx.callbacks, {
      event: "message.failed",
      data: { messageId: ctx.input.messageId, otterId: ctx.input.otterId, otterName, body: ctx.failBody },
    });

    let sysMsg;
    try {
      sysMsg = await ctx.callbacks.sendSystem(ctx.input.conversationId, ctx.retryMsg);
      this.safeEmitEvent(ctx.callbacks, {
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
    this.safeEmitEvent(ctx.callbacks, {
      event: 'message.aborted',
      data: { messageId, body, otterId, otterName: resolveSpeakerName("otter", otterId, otter?.name) ?? otterId },
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

    this.safeEmitEvent(callbacks, {
      event: 'error',
      data: { message: errorMessage, messageId, otterId },
    });

    return { messageId, duration: Date.now() - startTime };
  }

  /** F20260814mtrc：流事件埋点 - metrics 由 invoker 层 recordStreamEventMetrics 统一处理 */
  private recordStreamEventMetrics(_e: AgentStreamEvent, _callbacks: TurnCallbacks): void {
    // Metrics recording is handled by the invoker's onEvent callback.
    // This method is intentionally a no-op to avoid double-counting.
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
    err: unknown,
    ctx: { callbacks: TurnCallbacks; attemptStartTime: number },
  ): void {
    if (!ctx.callbacks.metrics) return;
    if (this.recordedAttempts.has(this.attemptKey(input.messageId, input.retryCount))) return;

    const errMeta = err as ErrorWithToolCallCount | undefined;

    if (reason.kind === 'guard_abort') {
      try {
        ctx.callbacks.metrics.recordGuardAbort(
          result?.modelAlias ?? errMeta?._modelAlias ?? "unknown",
          reason.guardReason,
        );
      } catch (e) {
        ctx.callbacks.logger.warn('metrics recordGuardAbort failed (non-fatal)', {
          reason: reason.guardReason,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.recordRetryIntent(reason, input.retryCount, ctx.callbacks);

    void this.recordAttempt({
      messageId: input.messageId,
      otterId: input.otterId,
      result,
      err,
      outcome: exitKindToOutcome(reason.kind, input.retryCount),
      retryCount: input.retryCount,
      manualRetry: input.manualRetry,
      startTime: ctx.attemptStartTime,
    }, ctx.callbacks);
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

    if (reason.kind === 'no_yield') {
      recordRetrySafe("no_yield");
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

  /** F20260821spcm: 旁白流失检测——LLM 输出了直出文本但未调 speak */
  private detectOrphanText(reason: ExitReason, result: InvokeResultShape): boolean {
    return reason.kind === 'no_yield'
      && !!result.directText?.trim()
      && result.directText.trim().length >= 20;
  }

  /** F20260821spcm: 旁白流失 metrics——LLM 输出了直出文本但未调 speak */
  private recordNoYieldWithOrphanText(
    otterId: string,
    input: TurnInput,
    callbacks: TurnCallbacks,
  ): void {
    if (!callbacks.metrics) return;
    try {
      callbacks.metrics.recordNoYieldWithOrphanText(otterId);
    } catch (err) {
      callbacks.logger.warn('metrics recordNoYieldWithOrphanText failed (non-fatal)', {
        messageId: input.messageId,
        otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 中断 Agent 生成 */
  requestAbort(otterId: string, messageId: string, driver: AttemptDriver): void {
    driver.abort(otterId, messageId);
  }
}
