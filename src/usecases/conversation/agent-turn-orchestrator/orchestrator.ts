/**
 * AgentTurnOrchestrator - 发言轮编排（usecase 层）
 *
 * F20260910ctlv 彻底切换：turn 生命周期从 messages 行剥离到 invokes 行。
 * - invoke 是行动主体：TurnInput.invokeId 必填；成功检测 = invoke.status 离开 running（yield 工具置 completed）
 * - 状态机操作对象：updateInvokeStatus / createInvokeEndEntry（无 message 态回调）
 * - SSE 只发 entry / invoke 事件（message 类事件已退役）
 * - 重试不再建新 message：同 invoke 内重试（retryMsg 进 userMessageContent）
 *
 * 反强编排原则：attemptDriver 回调仅限“重执行当前轮”，
 * 接口注释显式声明防扩写成流程引擎。
 */
/* eslint-disable max-lines */ // orchestrator consolidates retry/abort/metrics logic; splitting prematurely would harm readability

import type { AgentMetricsPort, InvokeOutcomeRecord } from "@usecases/ports/agent-metrics-port";
import type { Logger } from "@usecases/ports/logger";
import { toRetryLabel } from "@usecases/ports/agent-metrics-port";
import { getTraceContext } from "@usecases/ports/trace-context";
import type { ExitReason } from "./exit-classifier";
import { classifyExit, exitKindToOutcome } from "./exit-classifier";
import { isRetryableGuardAbort, buildRetryFailBody, buildGuardAbortBody, buildUserAbortBody, buildYieldRetryMsg, buildAutoRetryMsg, buildCircuitBreakFailBody, buildCircuitBreakSystemMsg, GUARD_BOUNCE_MAX, GUARD_BOUNCE_WINDOW_MS, buildGuardBounceMsg, buildGuardBounceFailBody, buildGuardBounceEscalationMsg } from "./retry-policy";
// #543：api_error 终态限流识别 + 告警文案（配额黑盒修复）
import { matchRateLimitError, buildRateLimitSystemMsg, buildRateLimitDescription } from "./rate-limit-error";
// #543 严重发现 1 修复：high 级 rate_limit 事件入 C3 高警队列——大獭不在场时 sendSystem 错过，
// 下一次 invoke 的 DynamicContext 补送达（复用 F20260826mwrd Part 4 管道，process 级单例直引，
// 与 interceptHealingReport 同模式；usecase 内部互引无跨层问题）
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { ErrorWithToolCallCount, InvokeResultShape, TurnInput, TurnResult, AttemptDriver, TurnCallbacks, RouteContext, TerminalContext } from "./types";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";

export class AgentTurnOrchestrator {
  /**
   * 已进入终态的 invoke 集合（abort/fail 防重入——同 invoke 不得二次终态化）。
   * F20260910ctlv：键从 messageId 换成 invokeId。
   */
  private readonly terminalInvokes = new Set<string>();
  /**
   * 已记录 metrics 的 attempt 键（invokeId:retryCount）。
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
  // eslint-disable-next-line max-lines-per-function, max-statements -- executeTurn is the core retry loop; splitting would obscure control flow（#543：+rate_limit err 元数据保留分支）
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
      const attemptKey = this.attemptKey(currentInput.invokeId, currentInput.retryCount);

      try {
        const attempt = await driver.invoke(currentInput, (event) => {
          this.recordStreamEventMetrics(event);
        });
        result = attempt.result;
        toolCallCount = attempt.toolCallCount;
      } catch (e) {
        err = e;
        // #543：err 路径保留 _modelAlias——rate_limit 落账需要模型标识（与 toolCallCount 同模式提取）
        const errMeta = e as ErrorWithToolCallCount;
        result = { text: '', ...(errMeta._modelAlias && { modelAlias: errMeta._modelAlias }) };
        toolCallCount = errMeta._toolCallCount ?? driver.getToolCallCount(currentInput.otterId, currentInput.invokeId);
      } finally {
        // 清理当前 attempt 的去重键，防止内存泄漏
        this.recordedAttempts.delete(attemptKey);
      }

      // F20260910ctlv：invoke 成功检测——yield 工具置 invoke completed（离开 running 即成功）
      const completedResult = await this.tryCompleteInvoke(
        currentInput, result, driver, { callbacks, startTime, attemptStartTime, toolCallCount },
      );
      if (completedResult) return completedResult;

      // Classify exit reason
      const userAbortedSet = new Set<string>();
      if (driver.isUserAborted(currentInput.invokeId)) {
        userAbortedSet.add(currentInput.invokeId);
      }
      const reason = classifyExit(
        { messageId: currentInput.invokeId, result, err, toolCallCount },
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
          invokeId: currentInput.invokeId,
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
        return routeResult as TurnResult;
      }

      // If routeByReason returns null, retry with updated input
      // F20260825rtmx: 按退出原因使用匹配的重试文案（timeout 用超时提醒，no_yield 用 yield 提醒）
      // F20260910ctlv：同 invoke 内重试——retryMsg 走 userMessageContent，不再建新 message
      currentInput = {
        ...currentInput,
        retryCount: 1,
        userMessageContent: this.buildRetryMsg(reason, toolCallCount, hasOrphanText),
      };
    }
  }

  /**
   * F20260910ctlv：invoke 成功检测（取代 tryCompleteSpeaking 的 messages speaking 判据）。
   *
   * 判据：invoke.status 离开 running——yield 工具调 createYieldEntry 时置 completed。
   * user abort 时不抢先完成（让 abort 路径收尾）。
   */
   
  private async tryCompleteInvoke(
    input: TurnInput,
    result: InvokeResultShape,
    driver: AttemptDriver,
    ctx: { callbacks: TurnCallbacks; startTime: number; attemptStartTime: number; toolCallCount: number },
  ): Promise<TurnResult | undefined> {
    const invoke = await ctx.callbacks.getInvokeById(input.invokeId);
    if (!invoke || invoke.status === "running") return undefined;

    // If user has aborted, don't complete - let abort path handle it
    if (driver.isUserAborted(input.invokeId)) return undefined;

    // invoke 已终态但非 completed（failed/aborted）：跳过成功收尾，让路由分支处理
    if (invoke.status !== "completed") return undefined;

    try {
      // token usage 落 invoke 行（终态快照）
      if (result.tokenUsage) {
        await ctx.callbacks.updateInvokeTokenUsage?.(input.invokeId, result.tokenUsage.input, result.tokenUsage.output);
      }

      void this.recordAttempt({
        invokeId: input.invokeId,
        otterId: input.otterId,
        result,
        outcome: 'success',
        retryCount: input.retryCount,
        manualRetry: input.manualRetry,
        startTime: ctx.attemptStartTime,
      }, ctx.callbacks);

      const duration = Date.now() - ctx.startTime;
      this.logger.info('Agent invocation completed', {
        otterId: input.otterId,
        conversationId: input.conversationId,
        invokeId: input.invokeId,
        duration,
        tokenUsage: result.tokenUsage,
        status: 'success',
      });

      // 发送 invoke.end + turn.complete 事件（yield 已发 entry.yield/invoke_end 由 tool-factory 负责；
      // 此处补发 invoke.end 终态事件保证前端右栏状态收敛——emitInvokeEnd 幂等安全）
      ctx.callbacks.emitInvokeEnd(input.invokeId, "completed", duration, { toolCallCount: ctx.toolCallCount, tokenUsage: result.tokenUsage });

      this.safeEmitEvent(ctx.callbacks, { event: "turn.complete", data: {} });

      return {
        invokeId: input.invokeId,
        duration,
        tokenUsage: result.tokenUsage,
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
        return this.handleUserAbort(ctx, reason);
      case 'guard_abort':
        return this.routeGuardAbort(reason, ctx);
      case 'api_error':
        // #543：api_error 终态限流识别——配额黑盒修复点。
        // 识别失败/写入失败不阻断 failTerminal（主路径），告警尽力而为。
        return this.handleApiError(reason, ctx);
      case 'no_yield':
        return this.handleYieldRetry(ctx);
      default:
        return { invokeId: ctx.input.invokeId, duration: Date.now() - ctx.startTime };
    }
  }

  /**
   * #543：api_error 终态处理——限流识别 → 落账 + 通知 → failTerminal。
   *
   * Why 在 orchestrator 而非 SDK 层：这里是错误消息的终端汇聚点（api_error 分类后）
   * 且 callbacks（sendSystem/recordHealingEvent/emitEvent）齐全；pi-session-factory
   * 层拿不到 sendSystem。识别是纯函数（matchRateLimitError），可单测。
   *
   * Why 不重试：SDK（agent-session）已内置 maxRetries=4 指数退避，能上抛到这里的
   * 429 要么是终态配额耗尽（isTerminalRateLimitError 判定不可重试），要么重试
   * 预算已耗尽——otter 层再叠加重试只会续期静默窗（#642 教训：重试无限续期 = 看门狗失明）。
   */
  private async handleApiError(
    reason: ExitReason & { kind: 'api_error' },
    ctx: RouteContext,
  ): Promise<TurnResult> {
    let match: ReturnType<typeof matchRateLimitError> = null;
    try {
      match = matchRateLimitError(reason.errorMessage);
    } catch (err) {
      ctx.callbacks.logger.warn('rate limit pattern match failed (non-fatal)', {
        invokeId: ctx.input.invokeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (match) {
      // 落账 + 通知均非致命：任一失败不阻断 failTerminal 主路径
      await this.recordRateLimitHealingEvent(ctx, match, reason).catch(() => { /* 已在内部记日志 */ });
      await this.notifyRateLimit(ctx, match).catch(() => { /* 通知失败不阻断 */ });
    }

    return this.failTerminal(ctx.input, reason.errorMessage, ctx.callbacks, ctx.startTime);
  }

  /** #543：rate_limit healing 落账（severity 按配额耗尽/瞬时分级）。
   *  严重发现 1 修复：high 级（配额耗尽）落账成功后同步入 C3 高警队列——
   *  sendSystem 只达当前在场者，大獭不在场即错过；C3 队列保证下次 invoke 补送达。 */
  private async recordRateLimitHealingEvent(
    ctx: RouteContext,
    match: NonNullable<ReturnType<typeof matchRateLimitError>>,
    reason: ExitReason & { kind: 'api_error' },
  ): Promise<void> {
    const modelAlias = this.resolveModelAlias(ctx);
    try {
      await ctx.callbacks.recordHealingEvent({
        invokeId: ctx.input.invokeId,
        conversationId: ctx.input.conversationId,
        otterId: ctx.input.otterId,
        errorType: "rate_limit",
        severity: match.exhausted ? "high" : "medium",
        description: buildRateLimitDescription({ modelAlias, exhausted: match.exhausted }),
        suggestion: match.exhausted
          ? "配额重置前该模型不可用：改派其他模型的獭，或等待重置时间后重试"
          : "短时限流：稍后重试或改派",
        context: {
          layer: "orchestrator",
          modelAlias,
          exhausted: match.exhausted,
          resetHint: match.resetHint ?? null,
          errorMessage: reason.errorMessage.slice(0, 500),
        },
      });
      // C3 高警入队：仅 high（配额耗尽）入；eventId 先行生成、与台账 create 同源双写
      // 各自失败不阻塞对方（interceptHealingReport 同款语义，审计面以 healing_events 为准）
      if (match.exhausted) {
        healingAlertRegistry.enqueue(ctx.input.conversationId, {
          eventId: crypto.randomUUID(),
          conversationId: ctx.input.conversationId,
          otterId: ctx.input.otterId,
          errorType: "rate_limit",
          description: buildRateLimitDescription({ modelAlias, exhausted: true }),
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      ctx.callbacks.logger.error('rate_limit healing_event write FAILED',
        err instanceof Error ? err : new Error(String(err)),
        { otterId: ctx.input.otterId, invokeId: ctx.input.invokeId },
      );
    }
  }

  /** #543：会话内告警（sendSystem + SSE）——检视席空转黑盒的主出口 */
  private async notifyRateLimit(
    ctx: RouteContext,
    match: NonNullable<ReturnType<typeof matchRateLimitError>>,
  ): Promise<void> {
    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    const modelAlias = this.resolveModelAlias(ctx);
    const msg = buildRateLimitSystemMsg({
      otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId,
      modelAlias,
      exhausted: match.exhausted,
      resetHint: match.resetHint,
    });
    await ctx.callbacks.sendSystem(ctx.input.conversationId, msg);
  }

  /** #543：模型标识解析——err 路径由 executeTurn catch 块保留在 result.modelAlias */
  private resolveModelAlias(ctx: RouteContext): string {
    return ctx.result?.modelAlias ?? 'unknown';
  }

  /** Handle user abort: 成功检测 → abort terminal */
  private async handleUserAbort(ctx: RouteContext, reason?: ExitReason & { kind: 'user_abort' }): Promise<TurnResult> {
    const invoke = await ctx.callbacks.getInvokeById(ctx.input.invokeId);
    /** invoke 已 completed（yield 后用户才点中断，或中断信号晚到）：按成功收尾 */
    if (invoke?.status === 'completed') {
      const duration = Date.now() - ctx.startTime;
      this.safeEmitEvent(ctx.callbacks, { event: "turn.complete", data: {} });
      return { invokeId: ctx.input.invokeId, duration };
    }

    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'user', underlyingError: reason?.underlyingError });
  }

  /** Route guard abort: degenerate circuit break → auto-retry → guard bounce → abort terminal */
  private async routeGuardAbort(
    reason: ExitReason & { kind: 'guard_abort' },
    ctx: RouteContext,
  ): Promise<TurnResult | null> {
    const { guardReason } = reason;
    const { retryCount } = ctx.input;

    if (guardReason === 'degenerate_output') {
      await this.recordDegenerateHealingEvent(ctx);
    }

    // F20260831dgrt：首次退化直接熔断（跳过无效重试，自愈更快更省）
    // 例外：session 由熔断创建且在 2h 窗口内——直接熔断会撞上限走 abort，保留重试作为唯一自愈机会
    if (guardReason === 'degenerate_output' && retryCount === 0) {
      let isCircuitBreakSession = false;
      try {
        isCircuitBreakSession = await ctx.callbacks.isSessionCircuitBreakCreated(ctx.input.otterId);
      } catch (err) {
        ctx.callbacks.logger.warn('isSessionCircuitBreakCreated check failed in routing, assuming false', {
          otterId: ctx.input.otterId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (isCircuitBreakSession) {
        // 保留路径：熔断创建的 session 在 2h 窗口内——重试是上限保护下唯一的自愈机会
        return this.handleAutoRetry(ctx, guardReason);
      }

      this.logger.info('First degenerate output: skip retry, direct circuit break (F20260831dgrt)', {
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
      });
      return this.handleCircuitBreak(ctx);
    }

    // F20260818cbkr：带污重试再次退化 → 熔断重启（上限判定在 handleCircuitBreak）
    if (guardReason === 'degenerate_output' && retryCount > 0) {
      return this.handleCircuitBreak(ctx);
    }

    if (retryCount === 0 && isRetryableGuardAbort(guardReason)) {
      this.logger.info('Auto-retry on guard abort', {
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
        guardReason,
      });
      return this.handleAutoRetry(ctx, guardReason);
    }

    // #731：bash 守卫二拦终态自动回发——拦截是反馈信号不是断头台（事故 C：终态后行动权悬空只能等用户手动拉起）
    if (this.shouldGuardBounce(guardReason, retryCount)) {
      return this.handleGuardBounce(reason, ctx);
    }
    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason });
  }

  /** 从 ExitReason 判断是否应走 #731 guard bounce（终态前最后一道判定，独立降复杂度） */
  private shouldGuardBounce(guardReason: string, retryCount: number): boolean {
    return guardReason.startsWith('bash_safety:') && retryCount > 0 && isRetryableGuardAbort(guardReason);
  }


  /** F20260818cbkr：degenerate guard 每次触发都落 healing_events（二级触发与观测的数据源，非致命） */
  private async recordDegenerateHealingEvent(ctx: RouteContext): Promise<void> {
    try {
      await ctx.callbacks.recordHealingEvent({
        invokeId: ctx.input.invokeId,
        conversationId: ctx.input.conversationId,
        otterId: ctx.input.otterId,
        errorType: "degenerate",
        severity: "high",
        description: `检测到输出异常重复（retry=${ctx.input.retryCount}）`,
        suggestion: "连续退化将触发熔断重启（F20260818cbkr）",
        context: {
          retryCount: ctx.input.retryCount,
          toolCallCount: ctx.toolCallCount,
        },
      });
    } catch (err) {
      // F20260827he2f: error 级别 + 完整上下文——让健康检查链路可观测
      ctx.callbacks.logger.error('degenerate healing_event write FAILED — circuit breaker data source degraded',
        err instanceof Error ? err : new Error(String(err)),
        {
          component: 'AgentTurnOrchestrator',
          errorType: 'degenerate',
          otterId: ctx.input.otterId,
          invokeId: ctx.input.invokeId,
          conversationId: ctx.input.conversationId,
          retryCount: ctx.input.retryCount,
        },
      );
    }
  }

  /**
   * F20260818cbkr 一级熔断：degenerate retry 本身再次退化。
   * 当前 invoke 收尾为 failed + 熔断说明；熔断信号跨层上抛（executeTurn 不消费），
   * 由 agent-invoker 执行 restartSession + 写 circuit_break 事件 + 全新 invoke。
   */
   
  private async handleCircuitBreak(ctx: RouteContext): Promise<TurnResult> {
    // 熔断依赖 healing_events 状态载体（上限/二级判定）；不可用时降级为旧 abort 语义
    if (!ctx.callbacks.isCircuitBreakerEnabled()) {
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }

    this.logger.info('Circuit break triggered', {
      invokeId: ctx.input.invokeId,
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
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
      });
      // F20260831cbkw：上限命中时发系统消息通知搭档（现状是静默死，搭档 8 小时后才发现）
      try {
        await ctx.callbacks.sendSystem(
          ctx.input.conversationId,
          '[系统保护] 该獭连续输出退化且已达熔断上限，发言已中断。如需恢复请重启该獭。',
        );
      } catch {
        // 通知失败不影响 abort 流程
      }
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason: 'degenerate_output' });
    }

    /**
     * sendSystem 是通知性 IO——失败仅留痕,不放弃 restartSession(治疗动作)。
     * (不回退 abortTerminal:invoke 已 failed,再广播 aborted 会与熔断文案矛盾)
     */
    try {
      await ctx.callbacks.sendSystem(ctx.input.conversationId, buildCircuitBreakSystemMsg());
    } catch (err) {
      this.logger.warn('sendSystem failed during circuit break (non-fatal, restart continues)', {
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // invoke 终态化 failed（invoke_end entry + 行状态）
    await this.finalizeInvokeFailed(ctx.input, buildCircuitBreakFailBody(), ctx.callbacks, ctx.startTime);

    return {
      invokeId: ctx.input.invokeId,
      duration: Date.now() - ctx.startTime,
      _circuitBreak: {
        otterId: ctx.input.otterId,
        conversationId: ctx.input.conversationId,
        originalUserMessage: ctx.input.originalUserMessage,
        failedInvokeId: ctx.input.invokeId,
        toolCallCount: ctx.toolCallCount,
      },
    };
  }

  /** F20260910ctlv：invoke 终态化 failed（invoke_end entry + 行状态 + SSE）——熔断/degenerate 路径共用 */
  private async finalizeInvokeFailed(
    input: TurnInput,
    failBody: string,
    callbacks: TurnCallbacks,
    startTime: number,
  ): Promise<void> {
    if (this.terminalInvokes.has(input.invokeId)) return;
    this.terminalInvokes.add(input.invokeId);
    try {
      await callbacks.updateInvokeStatus(input.invokeId, 'failed');
      await callbacks.createInvokeEndEntry(input.invokeId, 'failed', failBody);
      callbacks.emitInvokeEnd(input.invokeId, 'failed', Date.now() - startTime, { toolCallCount: 0 });
    } catch { /* already terminal */ }
  }

  /** Handle auto-retry: fail 过渡 + 系统提醒 + 同 invoke 重试
   *  F20260910ctlv：不再 failMessage/prepareForRetry（messages 状态机已退役）——
   *  发系统提醒 entry + 返回 null 让主循环重试 */
  private async handleAutoRetry(ctx: RouteContext, reason: string): Promise<TurnResult | null> {
    const failBody = `[系统] ${buildRetryFailBody(reason)}, 正在自动重试`;

    // 系统提醒（entry.system SSE 由 sendSystem 内部发射）
    try {
      await ctx.callbacks.sendSystem(ctx.input.conversationId, failBody);
    } catch (err) {
      this.logger.warn('sendSystem failed during auto-retry (non-fatal)', {
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // F20260910ctlv：entry.retry SSE（前端唯一重试信号；message.retry 已退役）
    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    this.safeEmitEvent(ctx.callbacks, {
      event: 'entry.retry',
      data: { entryId: ctx.input.invokeId, invokeId: ctx.input.invokeId, otterId: ctx.input.otterId, otterName: resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId, reason: buildRetryFailBody(reason), attempt: ctx.input.retryCount + 1 },
    });

    return null;
  }

  /**
   * #731：bash 守卫二拦终态自动回发控制信号（guard bounce）。
   *
   * 路径：上限判定（滑窗内已回发次数 ≥ GUARD_BOUNCE_MAX → abortTerminal 升级）
   * → sendSystem 写入对话流（搭档可见）→ 返回 null 主循环继续重试（同 invoke）。
   *
   * 计数载体：healing_events（errorType=guard_intercept 且 context.bounced=true）——
   * process 级内存计数在 invoker 单例生命周期外无意义，DB 是唯一跨消息真相源。
   * 查询经 TurnCallbacks.getRecentGuardBounces（不 fail-open：台账失明时宁可走升级路径，
   * 防御「写失败 → 计数失明 → 无限自循环」）。
   */
  // #731：bounce 主路径——上限判定/升级/回发三段，复杂度与回发执行已拆出子方法
  private async handleGuardBounce(
    reason: ExitReason & { kind: 'guard_abort' },
    ctx: RouteContext,
  ): Promise<TurnResult | null> {
    const { guardReason } = reason;

    // 有界防护：滑窗内 bounce 次数查询（写前查询——上限判定用，不依赖事后计数）；
    // 写前失败则计数不可信，走升级路径（fail-closed，不 fail-open）
    let priorBounces = 0;
    let countQueryFailed = false;
    try {
      priorBounces = await ctx.callbacks.getRecentGuardBounces(ctx.input.otterId, GUARD_BOUNCE_WINDOW_MS);
    } catch (err) {
      countQueryFailed = true;
      this.logger.error('guard bounce count query FAILED — fail-closed to escalation',
        err instanceof Error ? err : new Error(String(err)),
        { otterId: ctx.input.otterId, conversationId: ctx.input.conversationId },
      );
    }

    const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
    const otterName = resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId;

    // 超限 / 计数不可信 → 停止自动回发，升级上报（healing high 由 abortTerminal 终态分支落）
    if (countQueryFailed || priorBounces >= GUARD_BOUNCE_MAX) {
      return this.escalateGuardBounce(ctx, guardReason, otterName, priorBounces, countQueryFailed);
    }

    // bounce 计数落账（下一轮上限判定的数据源；失败仅日志——本轮回发照常，下轮查询兜底）
    try {
      await ctx.callbacks.recordHealingEvent({
        invokeId: ctx.input.invokeId,
        conversationId: ctx.input.conversationId,
        otterId: ctx.input.otterId,
        errorType: "guard_intercept",
        severity: "medium",
        description: `bash 守卫二拦终态自动回发控制信号（第 ${priorBounces + 1}/${GUARD_BOUNCE_MAX} 次）`,
        suggestion: "LLM 已收到拦截原因与正道引导；若后续仍持续被拦将升级上报",
        context: { layer: "orchestrator", bounce: true, guardReason, bounceAttempt: priorBounces + 1 },
      });
    } catch { /* 计数落账失败不阻断回发；上限判定失明时下轮 fail-closed 升级 */ }

    return this.executeGuardBounce(ctx, guardReason, otterName, priorBounces + 1);
  }

  /** #731：bounce 超限升级——停止自动回发，abort 终态 + 会话内用户可见通知 */
  private async escalateGuardBounce(
    ctx: RouteContext,
    guardReason: string,
    otterName: string,
    priorBounces: number,
    countQueryFailed: boolean,
  ): Promise<TurnResult> {
    this.logger.warn('Guard bounce limit reached (or count unavailable), escalating to abort', {
      otterId: ctx.input.otterId,
      conversationId: ctx.input.conversationId,
      priorBounces,
      countQueryFailed,
    });
    try {
      await ctx.callbacks.sendSystem(ctx.input.conversationId, buildGuardBounceEscalationMsg(otterName));
    } catch { /* 通知失败不阻断 abort 流程 */ }
    return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason });
  }

  /** #731：执行回发——sendSystem 写入对话流 + 同 invoke 重试（与 degenerate retry 同构） */
  private async executeGuardBounce(
    ctx: RouteContext,
    guardReason: string,
    otterName: string,
    attempt: number,
  ): Promise<TurnResult | null> {
    // 回发消息写入对话流：搭档可见、新 invoke 可读（sendSystem 是 entry 实体，不是 SSE 幻影）
    const bounceMsg = buildGuardBounceMsg(guardReason, attempt);
    try {
      await ctx.callbacks.sendSystem(ctx.input.conversationId, bounceMsg);
    } catch (err) {
      this.logger.warn('sendSystem failed during guard bounce, falling back to abort', {
        invokeId: ctx.input.invokeId,
        otterId: ctx.input.otterId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.abortTerminal({ input: ctx.input, toolCallCount: ctx.toolCallCount, callbacks: ctx.callbacks, startTime: ctx.startTime, kind: 'guard', guardReason });
    }

    // F20260910ctlv：entry.retry SSE + 返回 null 主循环同 invoke 重试
    this.safeEmitEvent(ctx.callbacks, {
      event: 'entry.retry',
      data: { entryId: ctx.input.invokeId, invokeId: ctx.input.invokeId, otterId: ctx.input.otterId, otterName, reason: buildGuardBounceFailBody(), attempt },
    });

    return null;
  }

  /** Handle yield retry: 系统提醒 + 同 invoke 重试 */
  private async handleYieldRetry(ctx: RouteContext): Promise<TurnResult | null> {
    if (ctx.input.retryCount === 0) {
      // 首轮 no_yield：系统提醒 + entry.retry + 重试（speak 内容若已有，entries 天然保留）
      const otter = await ctx.callbacks.getOtterById(ctx.input.otterId);
      const otterName = resolveSpeakerName("otter", ctx.input.otterId, otter?.name) ?? ctx.input.otterId;
      this.safeEmitEvent(ctx.callbacks, {
        event: 'entry.retry',
        data: { entryId: ctx.input.invokeId, invokeId: ctx.input.invokeId, otterId: ctx.input.otterId, otterName, reason: 'no_yield', attempt: ctx.input.retryCount + 1 },
      });
      return null;
    }

    this.logger.warn('Yield retry exhausted, failing invoke', {
      invokeId: ctx.input.invokeId,
      otterId: ctx.input.otterId,
      conversationId: ctx.input.conversationId,
    });

    const failBody = "[系统] 重试后仍未调用 yield 工具";

    // 发言石回传触发者（终态时无 yield 目标）
    await this.finalizeInvokeFailedWithTsp(ctx.input, failBody, [ctx.input.senderId], ctx.callbacks, ctx.startTime);
    this.safeEmitEvent(ctx.callbacks, {
      event: 'entry.failed',
      data: { entryId: ctx.input.invokeId, invokeId: ctx.input.invokeId, otterId: ctx.input.otterId, body: failBody },
    });

    return {
      invokeId: ctx.input.invokeId,
      duration: Date.now() - ctx.startTime,
      tokenUsage: ctx.result.tokenUsage,
    };
  }

  /** F20260910ctlv：invoke 终态化 failed + 发言石回传（no_yield 耗尽路径） */
  private async finalizeInvokeFailedWithTsp(
    input: TurnInput,
    failBody: string,
    talkingStonePassedTo: string[],
    callbacks: TurnCallbacks,
    startTime: number,
  ): Promise<void> {
    if (this.terminalInvokes.has(input.invokeId)) return;
    this.terminalInvokes.add(input.invokeId);
    try {
      await callbacks.updateInvokeStatus(input.invokeId, 'failed');
      await callbacks.updateInvokeTalkingStonePassedTo?.(input.invokeId, talkingStonePassedTo);
      await callbacks.createInvokeEndEntry(input.invokeId, 'failed', failBody);
      callbacks.emitInvokeEnd(input.invokeId, 'failed', Date.now() - startTime, {});
    } catch { /* already terminal */ }
  }

  /** Safe emitEvent wrapper - emitEvent is a user callback that can throw */
  private safeEmitEvent(callbacks: TurnCallbacks, event: { event: string; data: Record<string, unknown> }): void {
    try {
      callbacks.emitEvent(event);
    } catch {
      // Ignore SSE downstream failures - non-fatal
    }
  }

  /** Abort terminal: invoke 终态化 aborted + invoke_end entry + SSE */
   
  private async abortTerminal(ctx: TerminalContext): Promise<TurnResult> {
    const { invokeId, otterId } = ctx.input;

    if (this.terminalInvokes.has(invokeId)) {
      return { invokeId, duration: Date.now() - ctx.startTime };
    }

    this.terminalInvokes.add(invokeId);

    // F20260831aksp T3：编排层 high——同 invoke 二拦终态（retry>0）＝ LLM 无视首次引导自纠失败的前兆（事故 C 形态）
    if (ctx.kind === 'guard' && ctx.guardReason?.startsWith('bash_safety:') && ctx.input.retryCount > 0) {
      ctx.callbacks.recordHealingEvent({
        invokeId,
        conversationId: ctx.input.conversationId,
        otterId,
        errorType: "guard_intercept",
        severity: "high",
        description: `bash 守卫同消息二拦终态（retry=${ctx.input.retryCount}）：LLM 无视首次引导再次尝试，自纠失败`,
        suggestion: "查看对话定位该 otter 的任务是否涉及进程管理；必要时人工介入",
        context: { layer: "orchestrator", guardReason: ctx.guardReason },
      }).catch(() => { /* 观测写入非致命，失败不阻断终态 */ });
    }

    const actualToolCallCount = ctx.toolCallCount || 0;
    const body = ctx.kind === 'guard'
      ? buildGuardAbortBody(ctx.guardReason)
      : buildUserAbortBody(actualToolCallCount, await ctx.callbacks.getPartnerLabel(), ctx.underlyingError);

    try {
      await ctx.callbacks.updateInvokeStatus(invokeId, 'aborted');
      await ctx.callbacks.updateInvokeTalkingStonePassedTo?.(invokeId, ctx.input.senderId ? [ctx.input.senderId] : []);
      await ctx.callbacks.createInvokeEndEntry(invokeId, 'aborted', body);
    } catch { /* ignore */ }

    ctx.callbacks.emitInvokeEnd(invokeId, 'aborted', Date.now() - ctx.startTime, { toolCallCount: actualToolCallCount });

    return { invokeId, duration: Date.now() - ctx.startTime };
  }

  /** Fail terminal: invoke 终态化 failed + invoke_end entry + SSE error */
  private async failTerminal(
    input: TurnInput,
    errorMessage: string,
    callbacks: TurnCallbacks,
    startTime: number,
  ): Promise<TurnResult> {
    const { invokeId, otterId } = input;

    if (this.terminalInvokes.has(invokeId)) {
      return { invokeId, duration: Date.now() - startTime };
    }

    this.terminalInvokes.add(invokeId);

    try {
      await callbacks.updateInvokeStatus(invokeId, 'failed');
      await callbacks.createInvokeEndEntry(invokeId, 'failed', `[错误] ${errorMessage}`);
    } catch { /* ignore */ }

    callbacks.emitInvokeEnd(invokeId, 'failed', Date.now() - startTime, {});

    this.safeEmitEvent(callbacks, {
      event: 'error',
      data: { message: errorMessage, invokeId, otterId },
    });

    return { invokeId, duration: Date.now() - startTime };
  }

  /** F20260814mtrc：流事件埋点 - metrics 由 invoker 层 recordStreamEventMetrics 统一处理 */
  private recordStreamEventMetrics(_e: AgentStreamEvent): void {
    // Metrics recording is handled by the invoker's onEvent callback.
    // This method is intentionally a no-op to avoid double-counting.
  }

  /** 构建重试时的系统提醒消息（按退出原因匹配文案） */
  private buildRetryMsg(reason: ExitReason, toolCallCount: number, hasOrphanText: boolean): string {
    if (reason.kind === 'guard_abort') {
      return buildAutoRetryMsg(reason.guardReason);
    }
    return buildYieldRetryMsg(toolCallCount, hasOrphanText);
  }

  /** attempt 记录去重键 */
  private attemptKey(invokeId: string, retryCount: number): string {
    return `${invokeId}:${retryCount}`;
  }

  /** 记录一次 attempt 的 metrics */
  private async recordAttempt(
    p: {
      invokeId: string;
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
    const key = this.attemptKey(p.invokeId, p.retryCount);
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
    if (this.recordedAttempts.has(this.attemptKey(input.invokeId, input.retryCount))) return;

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
      invokeId: input.invokeId,
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
      // F20260831dgrt：新路由下首次退化直接熔断（不重试），此处记录的是"退化检测"而非"实际重试"
      // 改用 degenerate_detected 以保持 retries 指标的语义清晰——只计真正的重试意图
      recordRetrySafe("degenerate_detected");
      return;
    }
    if (isRetryableGuardAbort(reason.guardReason)) {
      const kind = reason.guardReason.startsWith('circuit_break:')
        ? 'circuit_break'
        : reason.guardReason.startsWith('bash_safety:')
          ? 'bash_safety'
          : reason.guardReason as 'streaming_timeout' | 'first_byte_timeout';
      recordRetrySafe(kind);
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
        invokeId: input.invokeId,
        otterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 中断 Agent 生成 */
  requestAbort(otterId: string, invokeId: string, driver: AttemptDriver): void {
    driver.abort(otterId, invokeId);
  }
}
