/**
 * AgentInvoker - SDK 调用适配器
 *
 * Why: Phase 2 将编排逻辑上提到 AgentTurnOrchestrator（usecase 层），
 * AgentInvoker 瘦身为 SDK 调用 + SSE 事件映射 + AttemptDriver 提供。
 *
 * 职责边界：
 * - orchestrator 负责：退出分类、重试决策、终态防护、metrics 埋点
 * - invoker 负责：SDK 调用、SSE 事件映射、消息生命周期、上下文构建
 */

import type { SdkInvokePort, AgentStreamEvent, DynamicContext } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import { aggregateBody } from "@entities/conversation/message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { SSEEvent } from "@contract/sse/events";
import { runWithTrace, getTraceContext, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { mapToSSEEvent, mapToMessageEventInput } from "@usecases/conversation/agent-turn-orchestrator/event-mapping";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import { CircuitBreakSupport } from "./circuit-break-support";
import type { TurnInput, AttemptDriver, TurnCallbacks, InvokeResultShape, CircuitBreakInfo, HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import type { AgentTurnPort, AgentTurnResult } from "@usecases/ports/agent-turn-port";

export class AgentInvoker implements AgentTurnPort {
  /** Messages explicitly aborted by the user (written only by abort()) */
  private readonly userAbortedMessages = new Set<string>();
  private readonly orchestrator: AgentTurnOrchestrator;
  /** F20260818cbkr：熔断执行器（healingRepo 未注入时为 null，熔断禁用） */
  private readonly circuitBreak: CircuitBreakSupport | null;

  // eslint-disable-next-line max-params -- AgentInvoker 依赖较多，参数数量由 DI 框架决定
  constructor(
    private readonly agentInvoke: SdkInvokePort,
    private readonly sendMessage: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    private readonly messageBroadcaster?: MessageBroadcaster,
    private readonly workspaceGateway?: WorkspaceGateway,
    private readonly settingsRepo?: SettingsRepository,
    /** F20260814mtrc：可选注入，缺省 no-op（不破坏既有测试） */
    private readonly metrics?: AgentMetricsPort,
    /** F20260818cbkr：可选注入，缺省禁用熔断（不破坏既有测试） */
    private readonly healingRepo?: HealingEventRepository,
  ) {
    this.orchestrator = new AgentTurnOrchestrator(logger, metrics);
    this.circuitBreak = healingRepo
      ? new CircuitBreakSupport({ manageSession, queryMessage, sendMessage, healingRepo, logger })
      : null;
  }

  /**
   * 驱动 Agent 对话：构建上下文 -> 创建 streaming 消息 -> invoke -> 事件映射 -> 完成/失败。
   * B7-B11 行为实现。
   *
   * streaming 事件通过 messageBroadcaster.broadcastEvent 统一推送给所有订阅者。
   * onSSEEvent 可选覆盖（测试用），默认走 broadcastEvent。
   *
   * F20260814mtrc：trace 兜底——已有链级 trace（DispatchChainEngine 注入）则直接执行；
   * 直连路径（scheduler/手动重试）生成新 traceId 并标记 source="direct"。
   */
  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    /** F20260814mtrc：Web 手动重试标识（retry label 区分 manual/auto） */
    manualRetry?: boolean;
  }): Promise<AgentTurnResult> {
    if (getTraceContext().traceId) {
      return this.invokeConversationInner(params);
    }
    return runWithTrace({ traceId: newTraceId(), source: "direct" }, () => this.invokeConversationInner(params));
  }

  private async invokeConversationInner(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    manualRetry?: boolean;
  }): Promise<AgentTurnResult> {
    const { otterId, conversationId, userMessageContent, senderId, onSSEEvent, retryCount = 0 } = params;
    const startTime = Date.now();

    // 统一事件推送：优先用 onSSEEvent 覆盖（测试），默认走 broadcastEvent
    const emitEvent = onSSEEvent ?? ((event: SSEEvent): void => {
      if (this.messageBroadcaster) {
        this.messageBroadcaster.broadcastEvent(conversationId, event);
      }
    });

    // 记录 Agent 调用开始日志
    this.logger.info('Agent invocation started', {
      otterId,
      conversationId,
      messageLength: userMessageContent.length,
      ...(retryCount > 0 && { retryCount }),
    });

    this.logger.debug('Building dynamic context', { otterId });
    /** F20260818cbkr 二级触发：invoke 前按 healing_events 推导，命中先重启（消息尚未创建，重启后摘要随新 invoke 注入） */
    await this.circuitBreak?.maybeSecondaryCircuitBreak(otterId, conversationId);
    const dynamicContext = await this.buildDynamicContext(otterId);
    await this.injectWorkspacePath(dynamicContext, conversationId);
    this.logger.debug('Dynamic context built', { otterId, hasSummary: !!dynamicContext.sessionSummary, hasWorkspace: !!dynamicContext.workspacePath });

    this.logger.debug('Creating streaming message', { otterId, conversationId });
    const message = await this.sendMessage.start({
      conversationId,
      senderId: otterId,
      talkingStonePassedTo: [senderId],
    });
    this.logger.debug('Streaming message created', { otterId, messageId: message.id });

    const otter = await this.queryOtter.getById(otterId);
    /** seq 带给前端：进行中消息按服务端 sequence 插入消息流（M5：保证跨 otter 时序正确） */
    emitEvent({ event: "message.start", data: { messageId: message.id, otterId, otterName: otter?.name ?? otterId, seq: message.sequenceNum, createdAt: message.createdAt } });

    // F20260814mtrc：messageId 进 trace scope（onEvent 回调与收尾日志自动携带）
    return runWithTrace({ messageId: message.id }, async () => {
      // F20260819rscn: 用闭包捕获自重启信号（orchestrator 不透传未知字段）
      let pendingSelfRestart: { otterId: string; summary?: string } | undefined;

      // 创建 AttemptDriver 和 TurnCallbacks
      const driver = this.createAttemptDriver(otterId, conversationId, dynamicContext, emitEvent, { otterName: otter?.name, onSelfRestart: (signal) => { pendingSelfRestart = signal; } });
      const callbacks = this.createTurnCallbacks(emitEvent);

      const turnInput = this.buildTurnInput(params, message.id, startTime);

      // 委托给 orchestrator 执行
      const turnResult = await this.orchestrator.executeTurn(turnInput, driver, callbacks);

      /**
       * F20260818cbkr 一级熔断：orchestrator 上抛熔断信号（executeTurn 循环内不消费）→
       * restart + 写 circuit_break 事件 + 全新 invoke（新入口重新 buildDynamicContext，前情摘要随新 session.summary 注入）。
       */
      const retried = await this.handleCircuitBreakSignal(turnResult, params, emitEvent);
      if (retried) return retried;

      /**
       * F20260819rscn 自重启信号：LLM 调用 restart_otter(self) 后，SDK 标记信号不执行 restart，
       * 由 agent-invoker 执行 restart + 全新 invoke（獭继续工作）。
       * Why 对齐 handleCircuitBreakSignal 模式：restart 后必须递归调用 invokeConversationInner，
       * 新 session 的 summary 仅在入口 buildDynamicContext 注入一次。
       */
      if (pendingSelfRestart) {
        const selfRestarted = await this.handleSelfRestartSignal(pendingSelfRestart, params);
        if (selfRestarted) return selfRestarted;
      }

      return {
        messageId: turnResult.messageId,
        duration: turnResult.duration,
        tokenUsage: turnResult.tokenUsage,
        aggregatedTargets: turnResult.aggregatedTargets,
      };
    });
  }

  /** 创建 AttemptDriver：包装 SdkInvokePort */
  private createAttemptDriver(
    otterId: string,
    conversationId: string,
    dynamicContext: DynamicContext,
    emitEvent: (event: SSEEvent) => void,
    opts?: { otterName?: string; onSelfRestart?: (signal: { otterId: string; summary?: string }) => void },
  ): AttemptDriver {
    return {
      invoke: async (input: TurnInput, onEvent: (event: AgentStreamEvent) => void) => {
        let toolCallCount = 0;
        const toolStarts = new Map<string, number>();

        this.logger.debug('Calling agentInvoke.invoke', { otterId: input.otterId, messageId: input.messageId });
        const result = await this.agentInvoke.invoke(input.otterId, input.userMessageContent, {
          dynamicContext,
          conversationId: input.conversationId,
          messageId: input.messageId,
          onEvent: (e: AgentStreamEvent) => {
            this.logger.debug('Agent event received', { messageId: input.messageId, eventType: e.type, toolName: e.name ?? e.toolName });
            this.recordStreamEventMetrics(e, toolStarts);
            if (e.type === "tool_execution_start") {
              toolCallCount++;
            }
            /** 所有事件如实推送到订阅者（event 就是 event，不抑制） */
            const sse = mapToSSEEvent(e);
            if (sse) {
              emitEvent({ event: sse.event, data: { ...sse.data, messageId: input.messageId } });
            }
            if (e.type === "tool_execution_end" && (e.name ?? e.toolName) === "speak") {
              this.logger.debug('speak tool executed', { messageId: input.messageId });
              this.emitSpeakIntermediate(e, input.messageId, otterId, opts?.otterName, emitEvent);
            }
            /** 所有事件如实持久化（event 就是 event，不抑制） */
            const evt = mapToMessageEventInput(e, input.messageId);
            if (evt) this.sendMessage.appendEvent(evt).catch((err: unknown) => {
              const m = err instanceof Error ? err.message : String(err);
              this.logger.warn(`Failed to persist message event for ${input.messageId}: ${m}`);
            });
            // 传递事件给 orchestrator
            onEvent(e);
          },
        });
        // F20260819rscn: SDK 标记了自重启信号时，通知调用方（闭包捕获）
        if (result._selfRestart) opts?.onSelfRestart?.(result._selfRestart);
        return { result: result as unknown as InvokeResultShape, toolCallCount };
      },

      abort: (otterId: string, messageId?: string) => {
        this.userAbortedMessages.add(messageId ?? '');
        this.agentInvoke.abort(otterId, messageId);
      },

      getInternalAbortReason: (messageId: string) => {
        return this.agentInvoke.getInternalAbortReason(messageId);
      },

      getToolCallCount: (otterId: string, messageId: string) => {
        return this.agentInvoke.getToolCallCount(otterId, messageId);
      },

      isUserAborted: (messageId: string) => {
        return this.userAbortedMessages.has(messageId);
      },
    };
  }

  /** 创建 TurnCallbacks：消息生命周期 + SSE 事件推送 */
  private createTurnCallbacks(
    emitEvent: (event: SSEEvent) => void,
  ): TurnCallbacks {
    return {
      completeMessage: async (messageId: string, input?: { contextTokens?: number; contextTokensMax?: number }) => {
        const cr = await this.sendMessage.complete(messageId, input);
        return { turnClose: { aggregatedTargets: cr.turnClose?.aggregatedTargets } };
      },

      failMessage: async (messageId: string, body?: string, talkingStonePassedTo?: string[]) => {
        await this.sendMessage.fail(messageId, body, talkingStonePassedTo);
      },

      abortMessage: async (messageId: string, input: { body: string; talkingStonePassedTo?: string[] }) => {
        await this.sendMessage.abort(messageId, { body: input.body, talkingStonePassedTo: input.talkingStonePassedTo ?? [] });
      },

      recordHealingEvent: async (input: HealingEventInput) => {
        if (!this.circuitBreak) return;
        await this.circuitBreak.recordHealingEvent(input);
      },

      isCircuitBreakerEnabled: () => !!this.circuitBreak,

      isSessionCircuitBreakCreated: async (otterId: string) => {
        return this.circuitBreak ? this.circuitBreak.isSessionCircuitBreakCreated(otterId) : false;
      },

      getMessageById: async (messageId: string) => {
        const msg = await this.queryMessage.getMessageById(messageId);
        return msg ? { status: msg.status, segments: msg.segments ?? [], turnId: msg.turnId } : null;
      },

      sendSystem: async (convId: string, body: string) => {
        const msg = await this.sendMessage.sendSystem(convId, body); return { id: msg.id, body: aggregateBody(msg.segments), sequenceNum: msg.sequenceNum };
      },

      startNewMessage: async (conversationId: string, senderId: string, talkingStonePassedTo: string[]) => {
        const msg = await this.sendMessage.start({ conversationId, senderId, talkingStonePassedTo });
        return { id: msg.id, sequenceNum: msg.sequenceNum, createdAt: msg.createdAt };
      },

      prepareForRetry: async (messageId: string) => {
        await this.sendMessage.prepareForRetry(messageId);
      },

      broadcastMessage: async (messageId: string) => {
        if (this.messageBroadcaster) {
          const msg = await this.queryMessage.getMessageById(messageId);
          if (msg) {
            await this.messageBroadcaster.broadcast(msg);
          }
        }
      },

      getOtterById: async (otterId: string) => {
        const otter = await this.queryOtter.getById(otterId);
        return otter ? { name: otter.name, type: otter.type } : null;
      },

      getPartnerLabel: async () => {
        return this.settingsRepo ? ((await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
      },

      emitEvent,

      logger: this.logger,

      metrics: this.metrics,
    };
  }

  /**
   * F20260814mtrc：流事件埋点——工具调用/耗时/错误、SDK 自动重试、compaction。
   * 工具按 toolCallId 配对计时（对齐 circuit-breaker 的防御式配对）。
   */
  private recordStreamEventMetrics(e: AgentStreamEvent, toolStarts: Map<string, number>): void {
    if (!this.metrics) return;
    try {
      this.recordStreamEventMetricsInner(e, toolStarts);
    } catch (err) {
      /** PR 审视修复：onEvent 在 SDK 事件分发通道内同步执行，metrics 异常绝不能打断事件流 */
      this.logger.warn('stream event metrics failed (non-fatal)', {
        eventType: e.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordStreamEventMetricsInner(e: AgentStreamEvent, toolStarts: Map<string, number>): void {
    if (!this.metrics) return;
    switch (e.type) {
      case "tool_execution_start": {
        this.metrics.recordToolCall(String(e.name ?? e.toolName ?? "unknown"));
        const toolCallId = e.toolCallId as string | undefined;
        if (toolCallId) toolStarts.set(toolCallId, Date.now());
        break;
      }
      case "tool_execution_end": {
        const tool = String(e.name ?? e.toolName ?? "unknown");
        this.recordToolEndMetric(e, tool, toolStarts);
        break;
      }
      case "auto_retry_start":
        this.metrics.recordRetry("sdk_auto");
        break;
      case "compaction_end":
        this.metrics.recordCompaction(String(e.reason ?? ""), e.aborted === true);
        break;
      default:
        break;
    }
  }

  /** 工具执行结束：按 toolCallId 配对计时 + 顶层 isError 错误计数 */
  private recordToolEndMetric(e: AgentStreamEvent, tool: string, toolStarts: Map<string, number>): void {
    const toolCallId = e.toolCallId as string | undefined;
    const start = toolCallId !== undefined ? toolStarts.get(toolCallId) : undefined;
    if (toolCallId !== undefined && start !== undefined) {
      this.metrics?.recordToolDuration(tool, Date.now() - start);
      toolStarts.delete(toolCallId);
    }
    /** 错误标志在事件顶层（result.isError 成功路径被 SDK 硬编码 false） */
    if (e.isError === true) this.metrics?.recordToolError(tool);
  }

  /** speak 落库成功后广播中间发言（前端实时展示，无需等 yield 交棒） */
  private emitSpeakIntermediate(
    e: AgentStreamEvent,
    messageId: string,
    otterId: string,
    otterName: string | undefined,
    emitEvent: (event: SSEEvent) => void,
  ): void {
    const details = (e.result as { details?: Record<string, unknown> } | undefined)?.details;
    if (details?.__speakIntermediate === true) {
      emitEvent({ event: "speak.intermediate", data: { messageId, body: String(details.body ?? ""), otterId, otterName: otterName ?? '' } });
    }
  }

  /** 中断 Agent 生成（UA-2: 调用 SdkInvokePort.abort()）；标记按 messageId 键控 */
  abort(otterId: string, messageId: string): void {
    this.userAbortedMessages.add(messageId);
    this.agentInvoke.abort(otterId, messageId);
  }

  /** 构建 DynamicContext：会话摘要（前情）。记忆召回由 agent 通过 search_memory tool 主动触发 */
  private async buildDynamicContext(
    otterId: string,
  ): Promise<DynamicContext> {
    const ctx: DynamicContext = {};

    try {
      let session = await this.manageSession.getActiveSession(otterId);
      if (!session) {
        /**
         * F20260805rsto 兜底：agent 会话存在但 domain 账本缺失（存量獭/异常路径）时补登记，
         * 保证「有 agent 会话 ⟹ 有 active domain session」，restart/dissolve 不再空操作。
         * 挂在这是因此处每次 invoke 本来就查一次 getActiveSession，零额外读放大，
         * 且 web/飞书/定时任务全部汇入本 invoker。
         */
        try {
          session = await this.manageSession.createSession(otterId);
          this.logger.info('Backfilled missing domain session on invoke', { otterId, action: 'session_backfill' });
        } catch (backfillErr) {
          /**
           * 并发补登记撞 conflict 属良性（他人已建）；其余失败必须留痕——
           * 兜底坏掉的唯一表现是 restart 再次静默空操作（F20260805rsto 原 bug 复发）。
           */
          this.logger.warn('Domain session backfill failed, re-reading active session', {
            otterId,
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
          });
          session = await this.manageSession.getActiveSession(otterId).catch(() => null);
        }
      }
      if (session?.summary) {
        ctx.sessionSummary = session.summary;
      }
    } catch (err) {
      this.logger.warn(`Session lookup failed for otter ${otterId}, degrading to no-session context:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return ctx;
  }

  /** 构建 TurnInput。F20260818cbkr：originalUserMessage 单独保留——retry 会覆写 userMessageContent 为系统提醒文案，熔断摘要必须取原始消息 */
  private buildTurnInput(
    params: { otterId: string; conversationId: string; userMessageContent: string; senderId: string; retryCount?: number; manualRetry?: boolean },
    messageId: string,
    startTime: number,
  ): TurnInput {
    const { otterId, conversationId, userMessageContent, senderId, retryCount = 0, manualRetry = false } = params;
    return {
      otterId,
      conversationId,
      messageId,
      userMessageContent,
      originalUserMessage: params.userMessageContent,
      senderId,
      retryCount,
      manualRetry,
      attemptStartTime: startTime,
    };
  }

  /** 注入对话工作区路径到 DynamicContext */
  private async injectWorkspacePath(ctx: DynamicContext, conversationId: string): Promise<void> {
    if (!this.workspaceGateway) return;
    const ok = await this.workspaceGateway.exists(conversationId);
    if (ok) {
      ctx.workspacePath = this.workspaceGateway.getWorkspacePath(conversationId);
    }
  }

  /**
   * F20260818cbkr：熔断信号处理。restart 成功 → 全新 invoke 的结果；未触发或降级返回 null。
   * 全新 invoke 是硬约束：sessionSummary 仅在 invokeConversation 入口 buildDynamicContext 注入一次，
   * orchestrator 内 continue 拿不到新 session 的前情摘要（详见 F20260818cbkr 实现红线）。
   */
  private async handleCircuitBreakSignal(
    turnResult: { _circuitBreak?: CircuitBreakInfo },
    params: {
      otterId: string;
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      onSSEEvent?: (event: SSEEvent) => void;
      retryCount?: number;
      manualRetry?: boolean;
    },
    emitEvent: (event: SSEEvent) => void,
  ): Promise<AgentTurnResult | null> {
    if (!turnResult._circuitBreak || !this.circuitBreak) return null;
    const restarted = await this.circuitBreak.executeCircuitBreakRestart(turnResult._circuitBreak, emitEvent);
    if (!restarted) return null;
    try {
      /** retryCount 归零：新 session 语义上等同新 invoke，首次退化应获得自我纠正机会而非直达熔断判定 */
      return await this.invokeConversationInner({ ...params, retryCount: 0, manualRetry: false });
    } catch (err) {
      /** 递归失败不掩盖已完成的熔断收尾：降级返回原 turnResult（消息已 failed，系统消息已发） */
      this.logger.error('Circuit break re-invoke failed, falling back to interrupted state', err instanceof Error ? err : new Error(String(err)), {
        otterId: params.otterId,
        conversationId: params.conversationId,
      });
      return null;
    }
  }

  /**
   * F20260819rscn：自重启信号处理。LLM 调用 restart_otter(self) 后，
   * SDK 标记 _selfRestart 信号不执行 restart；agent-invoker 执行 restart + 全新 invoke。
   * Why 对齐 handleCircuitBreakSignal：restart 后必须递归调用 invokeConversationInner，
   * 新 session 的 summary 仅在入口 buildDynamicContext 注入一次。
   * Why 不用 circuitBreak.executeCircuitBreakRestart：
   * 自重启不需要写 circuit_break healing 事件、不需要构建熔断摘要，语义不同。
   */
  private async handleSelfRestartSignal(
    signal: { otterId: string; summary?: string },
    params: {
      otterId: string;
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      onSSEEvent?: (event: SSEEvent) => void;
      retryCount?: number;
      manualRetry?: boolean;
    },
  ): Promise<AgentTurnResult | null> {
    if (!signal) return null;
    const { otterId, summary } = signal;
    try {
      const newSession = await this.manageSession.restartSession(otterId, summary);
      this.logger.info('Self-restart completed, re-invoking with new session', { otterId, newSessionId: newSession.id });
    } catch (restartErr) {
      this.logger.error('Self-restart failed, continuing with current session', restartErr instanceof Error ? restartErr : new Error(String(restartErr)), { otterId });
      return null;
    }
    try {
      return await this.invokeConversationInner({ ...params, retryCount: 0, manualRetry: false });
    } catch (reinvokeErr) {
      this.logger.error('Self-restart re-invoke failed, falling back to interrupted state', reinvokeErr instanceof Error ? reinvokeErr : new Error(String(reinvokeErr)), {
        otterId: params.otterId,
        conversationId: params.conversationId,
      });
      return null;
    }
  }
}
