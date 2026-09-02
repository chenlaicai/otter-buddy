/* eslint-disable max-lines -- Phase 1 新增触发链路；后续可拆分为 handoff-support.ts */
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
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { ScheduledTaskRepository } from "@usecases/scheduled-task/scheduled-task-repository";
import type { ManageContext } from "@usecases/otter/manage-context";
import type { LinkedResource } from "@entities/conversation/conversation";
// eslint-disable-next-line no-restricted-imports -- F20260825hndf: type-only import for DI injection
import type { buildHandoffPackage, HandoffPackageOptions, StateInventoryDeps } from "@frameworks/agent/handoff-package-builder";
// eslint-disable-next-line no-restricted-imports -- F20260901mbfx: type-only import（SynthesisPrefetch 机械预取数据，DI 注入同源）
import type { SynthesisPrefetch } from "@frameworks/agent/synthesis-prompt-builder";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";
// F20260826mwrd C3：高危 healing 事件提醒（Part 4 高危路由消费侧）
import { healingAlertRegistry, renderHealingAlerts } from "@usecases/healing/healing-alert-registry";
import { HandoffState, shouldTriggerHandoff, recordPostTurnTokens, restoreHandoffContext, DEFAULT_CTX_MAX } from "./handoff-support";
import { MIN_SENSIBLE_CTX_WINDOW, type OtterContextWindowProvider } from "@usecases/ports/otter-context-window-provider";
import { mapToSSEEvent, mapToMessageEventInput } from "@usecases/conversation/agent-turn-orchestrator/event-mapping";
import { AgentTurnOrchestrator } from "@usecases/conversation/agent-turn-orchestrator/orchestrator";
import { CircuitBreakSupport } from "./circuit-break-support";
import type { TurnInput, AttemptDriver, TurnCallbacks, InvokeResultShape, CircuitBreakInfo, HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import type { AgentTurnPort, AgentTurnResult } from "@usecases/ports/agent-turn-port";

/**
 * 审视 P1 红线代码化：两条路径的 options 构造函数。
 * buildAutoHandoffOptions 仅限 70% 自动交接路径（唯一允许携带 synthesize）；
 * buildManualHandoffOptions 供手动/熔断路径使用——参数类型上就没有 synthesize，
 * LLM 合成在签名层无法接入（红线：已陷复读不做优雅交接）。
 */
function buildAutoHandoffOptions(input: {
  inventoryDeps: StateInventoryDeps;
  queryMessage: QueryMessage;
  logger: Logger;
  synthesize: (prompt: string) => Promise<string>;
  trigger: HandoffPackageOptions["trigger"];
  /** F20260901mbfx：旧 session ID（机械查询，审计 F2） */
  oldSessionId?: string;
  /** F20260901mbfx：交接谱系（从旧 summary 机械继承，审计 F3） */
  lineage?: string;
  /** F20260901mbfx：合成 §④/⑥ 机械预取数据（审计 F1/F5） */
  prefetch?: SynthesisPrefetch;
}): HandoffPackageOptions {
  return {
    recencyTokens: 8000,
    stateInventoryDeps: input.inventoryDeps,
    queryMessage: input.queryMessage,
    logger: input.logger,
    synthesize: input.synthesize,
    oldSessionId: input.oldSessionId,
    lineage: input.lineage,
    prefetch: input.prefetch,
    trigger: input.trigger,
  };
}

function buildManualHandoffOptions(input: {
  inventoryDeps: StateInventoryDeps;
  queryMessage: QueryMessage;
  logger: Logger;
  trigger: HandoffPackageOptions["trigger"];
}): HandoffPackageOptions {
  // 红线：手动/熔断路径不携带 synthesize，摘要走机械转储或调用者提供的叙事
  return {
    recencyTokens: 8000,
    stateInventoryDeps: input.inventoryDeps,
    queryMessage: input.queryMessage,
    logger: input.logger,
    trigger: input.trigger,
  };
}

export class AgentInvoker implements AgentTurnPort {
  /** Messages explicitly aborted by the user (written only by abort()) */
  private readonly userAbortedMessages = new Set<string>();
  private readonly orchestrator: AgentTurnOrchestrator;
  /** F20260818cbkr：熔断执行器（healingRepo 未注入时为 null，熔断禁用） */
  private readonly circuitBreak: CircuitBreakSupport | null;
  /** F20260825hndf：handoff 状态管理 */
  private readonly handoffState = new HandoffState();
  /** F20260901cxmw：按 otter 缓存解析出的 ctxMax（池条目启动后不可变，见 ModelPool 注释） */
  private readonly resolvedCtxMax = new Map<string, number>();
  /** F20260901cxmw：按 otter 缓存解析出的 ctxMax。缓存边界（cxrev 审视发现 #3 措辞精确化）：
   * ModelPool 的 entries 启动后不可变；defaultAlias 可通过 settings 页运行时切换，
   * 仅影响无显式 modelAlias otter 的新解析（新 session 口径）——已缓存的 otter 保持首解析值。 */

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
    /** F20260825hndf：可选注入，用于活状态盘点（不破坏既有测试） */
    private readonly conversationRepo?: ConversationRepository,
    /** F20260825hndf：可选注入，用于调度任务盘点（不破坏既有测试） */
    private readonly scheduledTaskRepo?: ScheduledTaskRepository,
    /** F20260825hndf：可选注入，用于产物盘点（不破坏既有测试） */
    private readonly listArtifacts?: (conversationId: string) => Promise<LinkedResource[]>,
    /** F20260825hndf：可选注入，用于 otter_context 读写（借用式交接上下文） */
    private readonly manageContext?: ManageContext,
    /** F20260825hndf：可选注入，四件套构建器（从 bootstrap 注入，避免 interface-adapters→frameworks 直接依赖） */
    private readonly buildHandoffPkg?: typeof buildHandoffPackage,
    /** F20260831cbkw：可选注入，熔断 session 年龄窗口阈值（ms），缺省 2h */
    private readonly healthySessionThresholdMs?: number,
    /** F20260901cxmw：可选注入，otter 实际模型 contextWindow 解析（缺省回退 128k，兼容旧测试） */
    private readonly ctxWindowProvider?: OtterContextWindowProvider,
  ) {
    this.orchestrator = new AgentTurnOrchestrator(logger, metrics);
    this.circuitBreak = healingRepo
      ? new CircuitBreakSupport({ manageSession, queryMessage, sendMessage, healingRepo, logger, healthySessionThresholdMs })
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
    /** 多模态 Phase 1：当前任务消息携带的图片（≤2 张，dispatch-chain 透传） */
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  }): Promise<AgentTurnResult> {
    if (getTraceContext().traceId) {
      return this.invokeConversationInner(params);
    }
    return runWithTrace({ traceId: newTraceId(), source: "direct" }, () => this.invokeConversationInner(params));
  }

  // eslint-disable-next-line max-lines-per-function -- 触发链路+熔断+自重启集成点（F20260826mwrd C3：+healing 高危路由消费），拆分降低可读性（F20260901cxmw：getCtxMax 改同步后 complexity 已降至限内，无需 disable）
  private async invokeConversationInner(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    manualRetry?: boolean;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  }): Promise<AgentTurnResult> {
    const { otterId, conversationId, userMessageContent, senderId, onSSEEvent, retryCount = 0, images } = params;
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

    /** F20260825hndf Pre-invoke 检查：上轮 ctxTokens 超 70% 阈值 → 先 handoff 再处理本轮消息
     * F20260901cxmw：ctxMax 按 otter 实际模型窗口解析（同步，带缓存） */
    const ctxMax = this.getCtxMax(otterId);
    if (shouldTriggerHandoff(otterId, this.handoffState, ctxMax)) {
      this.logger.info('[handoff] Pre-invoke threshold exceeded', { otterId, ctxMax });
      await this.handleHandoff(otterId, conversationId);
    }

    this.logger.debug('Building dynamic context', { otterId });
    /** F20260818cbkr 二级触发：invoke 前按 healing_events 推导，命中先重启（消息尚未创建，重启后摘要随新 invoke 注入） */
    await this.circuitBreak?.maybeSecondaryCircuitBreak(otterId, conversationId);
    const dynamicContext = await this.buildDynamicContext(otterId);
    // F20260826mwrd C3（Part 4）：高危 healing 事件提醒——仅 big 獭消费（编排者处置义务），
    // small 獭 invoke 不取队列（队列滞留，大獭下轮补提醒）。失败不阻断主流程（台账在，提醒可再等）。
    // otterType 查询与下方 otter 复用：此处仅取 type，会话中 otter 主体仍在 streaming 消息创建后取。
    const otterType = (await this.queryOtter.getById(otterId))?.type;
    if (otterType === 'big') {
      const alerts = healingAlertRegistry.takeAll(conversationId);
      if (alerts.length > 0) {
        dynamicContext.healingAlerts = renderHealingAlerts(alerts);
        this.logger.info('Healing high alerts injected', { otterId, conversationId, count: alerts.length });
      }
    }
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
    /** seq 带给前端：进行中消息按服务端 sequence 插入消息流（M5：保证跨 otter 时序正确）。
     *  otterName 用 snapshot-first 策略：message.senderName（层 1 持久化快照）优先于运行时查询——
     *  自重启/熔断场景下快照在 SendMessage.start() 时已解析，不依赖运行时 otter 查询。 */
    emitEvent({ event: "message.start", data: { messageId: message.id, otterId, otterName: resolveSpeakerName("otter", otterId, message.senderName || otter?.name) ?? otterId, seq: message.sequenceNum, createdAt: message.createdAt } });

    // F20260814mtrc：messageId 进 trace scope（onEvent 回调与收尾日志自动携带）
    return runWithTrace({ messageId: message.id }, async () => {
      // F20260819rscn: 用闭包捕获自重启信号（orchestrator 不透传未知字段）
      let pendingSelfRestart: { otterId: string; summary?: string } | undefined;

      // 创建 AttemptDriver 和 TurnCallbacks
      const driver = this.createAttemptDriver(otterId, conversationId, dynamicContext, emitEvent, { otterName: otter?.name, onSelfRestart: (signal) => { pendingSelfRestart = signal; }, images });
      // F20260830fabt: failMessage 必须同时 abort SDK session——消息标 failed 后 LLM 不能继续跑
      // 注意：不走 driver.abort() 以免触发 userAbortedMessages 标记（那是用户中断的语义）
      const callbacks = this.createTurnCallbacks(emitEvent, () => this.agentInvoke.abort(otterId, message.id));

      const turnInput = this.buildTurnInput(params, message.id, startTime);

      // 委托给 orchestrator 执行
      const turnResult = await this.orchestrator.executeTurn(turnInput, driver, callbacks);

      /** F20260825hndf Post-turn 记录 */
      await recordPostTurnTokens(otterId, message.id, this.queryMessage, this.handoffState, this.logger);

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
        const selfRestarted = await this.handleSelfRestartSignal(pendingSelfRestart, params, message.id);
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
    opts?: { otterName?: string; onSelfRestart?: (signal: { otterId: string; summary?: string }) => void; images?: Array<{ type: "image"; data: string; mimeType: string }> },
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
          ...(opts?.images && { images: opts.images }),
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
  // eslint-disable-next-line max-lines-per-function -- 回调装配表（#731：+getRecentGuardBounces）
  private createTurnCallbacks(
    emitEvent: (event: SSEEvent) => void,
    /** F20260830fabt: failMessage 后 abort SDK session，防止 dead message 僵尸运行 */
    abortFn?: () => void,
  ): TurnCallbacks {
    return {
      completeMessage: async (messageId: string, input?: { contextTokens?: number; contextTokensMax?: number }) => {
        const cr = await this.sendMessage.complete(messageId, input);
        return { turnClose: { aggregatedTargets: cr.turnClose?.aggregatedTargets } };
      },

      failMessage: async (messageId: string, body?: string, talkingStonePassedTo?: string[]) => {
        await this.sendMessage.fail(messageId, body, talkingStonePassedTo);
        // F20260830fabt: 消息标 failed 后立即 abort SDK session，阻止 LLM 在 dead message 上继续运行
        abortFn?.();
      },

      abortMessage: async (messageId: string, input: { body: string; talkingStonePassedTo?: string[] }) => {
        await this.sendMessage.abort(messageId, { body: input.body, talkingStonePassedTo: input.talkingStonePassedTo ?? [] });
      },

      recordHealingEvent: async (input: HealingEventInput) => {
        if (!this.circuitBreak) return;
        await this.circuitBreak.recordHealingEvent(input);
      },

      // #731：bounce 计数查询——直透 CircuitBreakSupport（无 healingRepo 时 circuitBreak 为 null，
      // 拋错交由 orchestrator fail-closed 升级；不静默返回 0，防「降级配置下无限回发」）
      getRecentGuardBounces: async (otterId: string, windowMs: number) => {
        if (!this.circuitBreak) throw new Error('guard bounce count unavailable: healing repo not configured');
        return this.circuitBreak.countRecentGuardBounces(otterId, windowMs);
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

      prepareForRetry: async (messageId: string, preserveSegments?: boolean) => {
        await this.sendMessage.prepareForRetry(messageId, preserveSegments);
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
      // ?? otterId: null/undefined 时兜底到 otterId（UUID），避免空串被前端 || 跳过显示 'Otter'
      // F-multi-speak-bubble: 传递 segmentId + sequenceNum 用于前端分段渲染
      emitEvent({ event: "speak.intermediate", data: { messageId, body: String(details.body ?? ""), otterId, otterName: resolveSpeakerName("otter", otterId, otterName) ?? otterId, segmentId: details.segmentId as string, sequenceNum: details.sequenceNum as number } });
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

    // F20260825hndf：从 otter_context 恢复交接上下文（借用式，消费即删）
    await restoreHandoffContext(otterId, ctx, this.manageContext, this.logger);

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
   * F20260825hndf：优雅上下文交接。
   * 检测到 ctxTokens 超阈值后，构建四件套上下文包，重启 session。
   * 件①写入 session.summary（已有路径），件路径），件②③④写入 otter_context（借用式）。
   */
  // eslint-disable-next-line max-statements, complexity -- 交接触发+补偿删除+降级链
  private async handleHandoff(otterId: string, conversationId: string): Promise<void> {
    // 防重入
    if (this.handoffState.isInProgress(otterId)) {
      this.logger.warn("[handoff] Already in progress, skipping", { otterId });
      return;
    }
    this.handoffState.setInProgress(otterId, true);

    try {
      const workspacePath = this.workspaceGateway?.getWorkspacePath(conversationId);

      // 构建四件套（D9：显式守卫，永不阻塞 restart）
      if (!this.buildHandoffPkg) { this.logger.warn("[handoff] buildHandoffPkg not injected, skipping"); return; }
      if (!this.conversationRepo) { this.logger.warn("[handoff] conversationRepo not injected, skipping"); return; }

      // F20260825hndf Phase 2：构建 LLM 合成函数（readOnly invocation）。
      // 红线（审视 P1）：synthesize 仅允许出现在 70% 自动交接路径——熔断/手动路径
      // 绝不走 LLM 合成（已陷复读不做优雅交接）。代码层用 buildAutoHandoffOptions /
      // buildManualHandoffOptions 两个函数隔离：手动/熔断侧的 options 签名上就传不进
      // synthesize，违规无法顺手发生，红线不靠纪律维持。
      const synthesize = this.buildSynthesisFunction(otterId, conversationId);

      const pkg = await this.buildHandoffPkg(
        conversationId,
        otterId,
        await this.buildAutoHandoffOptionsWithMechanicals(conversationId, otterId, workspacePath, synthesize),
      );

      // 件件②③④写入 otter_context（借用式，首次 invoke 后删除）
      if (this.manageContext) {
        try {
          await this.manageContext.set(otterId, "handoff_file_trail", pkg.fileTrail);
          await this.manageContext.set(otterId, "handoff_recency_window", pkg.recencyWindow);
          await this.manageContext.set(otterId, "handoff_state_inventory", pkg.stateInventory);
        } catch (ctxErr) {
          this.logger.warn("[handoff] Failed to write context, continuing with summary only", {
            otterId, error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr),
          });
        }
      }

      // 件①写入 session.summary（重启 session）
      try {
        await this.manageSession.restartSession(otterId, pkg.summary);
        this.handoffState.clearLastCtxTokens(otterId);
        this.logger.info("[handoff] Session restarted with handoff package", {
          otterId,
          totalTokens: pkg.totalTokenEstimate,
        });
      } catch (restartErr) {
        // D8 补偿删除：restart 失败时清理已写入的 context，防止幽灵上下文泄漏到旧 session
        if (this.manageContext) {
          for (const key of ['handoff_file_trail', 'handoff_recency_window', 'handoff_state_inventory']) {
            await this.manageContext.delete(otterId, key).catch(() => {});
          }
        }
        this.logger.error("[handoff] Restart failed, continuing with old session",
          restartErr instanceof Error ? restartErr : new Error(String(restartErr)),
          { otterId });
      }
    } catch (err) {
      this.logger.error("[handoff] Unexpected error",
        err instanceof Error ? err : new Error(String(err)),
        { otterId });
    } finally {
      this.handoffState.setInProgress(otterId, false);
    }
  }

  /**
   * 审视 P2/P1：stateInventoryDeps 的统一构造（三条路径共用，消除重复）。
   */
  private buildStateInventoryDeps(conversationId: string, workspacePath?: string): StateInventoryDeps {
    return {
      queryMessage: this.queryMessage,
      conversationRepo: this.conversationRepo!,
      scheduledTaskRepo: this.scheduledTaskRepo,
      healingRepo: this.healingRepo ?? undefined,
      listArtifacts: this.listArtifacts ? () => this.listArtifacts!(conversationId) : (async () => []),
      workspacePath,
      logger: this.logger,
    };
  }

  /**
   * F20260901mbfx（审计 F1/F2/F3/F5）：组装 70% 自动交接 options + 机械供料。
   *
   * 枚举型事实不堆叠 LLM：oldSessionId（当前 active session 真实 ID，此前未接线
   * 导致谱系行永远显示 otter UUID）、lineage（旧 summary 谱系行，供新代追加）、
   * prefetch（context keys / active 产物 / 最近搭档消息）。全部客忍失败，不阻塞交接。
   */
  private async buildAutoHandoffOptionsWithMechanicals(
    conversationId: string,
    otterId: string,
    workspacePath: string | undefined,
    synthesize: ReturnType<AgentInvoker["buildSynthesisFunction"]>,
  ): Promise<HandoffPackageOptions> {
    const { oldSessionId, lineage } = await this.resolveHandoffLineage(otterId);
    return buildAutoHandoffOptions({
      inventoryDeps: this.buildStateInventoryDeps(conversationId, workspacePath),
      queryMessage: this.queryMessage,
      logger: this.logger,
      synthesize,
      trigger: '70%阈值',
      oldSessionId,
      lineage,
      prefetch: await this.buildSynthesisPrefetch(conversationId, otterId),
    });
  }

  /**
   * F20260901mbfx（审计 F2/F3）：交接谱系机械解析。
   *
   * 从当前 active session 的 summary（上一代交接时写入）提取既有谱系行
   * （`- genN xxx:` 格式，每代一行只追加），并返回真实 session ID。
   * 查询失败不阻塞交接（返回 undefined，合成端 gen1 重建谱系）——谱系是增强
   * 信息，不是交接硬依赖（D9 同源原则）。
   */
  private async resolveHandoffLineage(otterId: string): Promise<{ oldSessionId?: string; lineage?: string }> {
    try {
      const active = await this.manageSession.getActiveSession(otterId);
      if (!active) return {};
      // 从旧 summary 提取谱系行：匹配「- genN 开头」的行（kimi 模板 §⑦ 格式）。
      // 历史兼容：旧代未带 gen 标记时提取不到，视为谱系断档，新代从 gen1 重建。
      const lineage = (active.summary ?? '')
        .split('\n')
        .filter(l => /^\s*-\s*gen\d+\s/.test(l))
        .map(l => l.trim())
        .join('\n');
      return {
        oldSessionId: active.id,
        lineage: lineage.length > 0 ? lineage : undefined,
      };
    } catch (err) {
      this.logger.warn('[handoff] Lineage resolve failed, continuing without', {
        otterId, error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * F20260901mbfx（审计 F1/F5）：合成 §④/⑥ 机械预取。
   *
   * 枚举型事实机械供料（判据：必然准确的给机制）：context keys、active 产物清单、
   * 最近搭档消息原文。全部容忍失败（返回部分数据或 undefined），不阻塞交接。
   */
  private async buildSynthesisPrefetch(conversationId: string, otterId: string): Promise<SynthesisPrefetch | undefined> {
    const results = await Promise.allSettled([
      this.manageContext ? this.manageContext.get(otterId) : Promise.resolve({} as Record<string, string>),
      this.listArtifacts ? this.listArtifacts(conversationId) : Promise.resolve([] as LinkedResource[]),
      this.fetchRecentUserMessages(conversationId),
    ]);
    const prefetch: SynthesisPrefetch = {};
    if (results[0].status === 'fulfilled') prefetch.contextKeys = Object.keys(results[0].value);
    if (results[1].status === 'fulfilled') {
      prefetch.activeArtifacts = (results[1].value as Array<{ id: string; resourceType: string; title?: string; status?: string }>)
        .filter(a => !a.status || a.status === 'active')
        .map(a => ({ id: a.id, resourceType: a.resourceType, title: a.title }));
    }
    if (results[2].status === 'fulfilled' && results[2].value.length > 0) prefetch.recentUserMessages = results[2].value;
    return Object.keys(prefetch).length > 0 ? prefetch : undefined;
  }

  /**
   * F20260901mbfx：拉取最近 N 条用户（搭档）消息原文，时间正序。
   * 供合成 prompt §⑥ 机械预取——LLM 只负责挑选哪句是指令，不负责翻找。
   */
  private async fetchRecentUserMessages(conversationId: string, limit = 6): Promise<string[]> {
    try {
      const messages = await this.queryMessage.getMessages(conversationId, { limit, senderType: 'user' });
      return messages
        .map(m => aggregateBody(m.segments).trim())
        .filter(t => t.length > 0 && t.length <= 500)
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * F20260825hndf Phase 2：构建 LLM 叙事合成函数。
   *
   * 返回一个闭包，接收 prompt 字符串，返回 LLM 合成的摘要文本。
   * 内部调用 readOnly invocation（跳过消息持久化和 SSE 广播）。
   */
  private buildSynthesisFunction(otterId: string, conversationId: string): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      this.logger.info('[handoff-synthesis] Starting readOnly invocation', { otterId, conversationId });

      // 构建动态上下文（包含 session summary，但不包含件②③④——那些是给新 session 的）
      const dynamicContext: DynamicContext = {};

      // readOnly 调用：跳过消息持久化和 SSE 广播
      const result = await this.agentInvoke.invoke(otterId, prompt, {
        conversationId,
        dynamicContext,
        readOnly: true,
      });

      // F20260901dtfx：LLM 直出文本在 directText（turnText 缓冲，pi-session-factory
      // 在 invoke 结果组装后填充），result.text 是 buildInvokeResult 的占位空串——
      // 只读 text 会 100% 误判 empty result，把已生成的摘要扔进降级（Phase 2 上线
      // 后微信对话 3/3 合成全失败的根因）。fallback 链：directText → text → 失败。
      const synthesisText = result.directText?.trim() || result.text?.trim() || '';

      if (synthesisText.length === 0) {
        throw new Error('LLM synthesis returned empty result');
      }

      this.logger.info('[handoff-synthesis] Completed', {
        otterId,
        length: synthesisText.length,
        source: result.directText?.trim() ? 'directText' : 'text',
      });

      return synthesisText;
    };
  }

  /** F20260827he2f：healing_repo 健康探针——外部健康检查可调用，验证熔断事件落库能力 */
  async probeHealingRepo(): Promise<boolean> {
    return this.circuitBreak ? this.circuitBreak.probeHealingRepo() : false;
  }

  /**
   * F20260825hndf→F20260901cxmw：解析 otter 实际模型的 contextWindow。
   *
   * 回退链：otter 配了 modelAlias → getContextWindow(alias)；
   * 没配 alias → 默认模型窗口（provider 闭包内 getContextWindow(undefined)）；
   * 查出 undefined / 0 / < 合理下限 → DEFAULT_CTX_MAX 兜底
   * （models-factory 注释实锤：contextWindow 缺省时 SDK 视为 0，会让阈值恒真）。
   *
   * 结果按 otterId 缓存：ModelPool 条目启动后不可变，仅默认 alias 可运行时切换
   * （settings 页），切换只影响新 session 的窗口口径，缓存可接受。
   */
  private getCtxMax(otterId: string): number {
    const cached = this.resolvedCtxMax.get(otterId);
    if (cached !== undefined) return cached;

    const window = this.ctxWindowProvider?.getOtterContextWindow(otterId);
    const usable = window !== undefined && window >= MIN_SENSIBLE_CTX_WINDOW;
    const resolved = usable ? window : DEFAULT_CTX_MAX;
    const source = usable ? 'model-pool' : 'fallback-128k';
    this.resolvedCtxMax.set(otterId, resolved);
    // 低噪声可观测：每 otter 仅首饮打一次，部署后 grep 该事件即可验证解析链路
    this.logger.info('[handoff] ctxMax resolved', { otterId, ctxMax: resolved, source });
    return resolved;
  }

  /**
   * F20260818cbkr：熔断信号处理。restart 成功 → 全新 invoke 的结果；未触发或降级返回 null。
   * 全新 invoke 是硬约束：sessionSummary 仅在 invokeConversation 入口 buildDynamicContext 注入一次，
   * orchestrator 内 continue 拿不到新 session 的前情摘要（详见 F20260818cbkr 实现红线）。
   */
  // eslint-disable-next-line complexity -- Phase 2: 熔断路径+四件套注入+补偿删除
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

    // F20260825hndf Phase 2：熔断重启统一带四件套（机械转储，不走 LLM 合成）
    // 红线（审视 P1）：用 buildManualHandoffOptions 构建——该函数类型上就不接受
    // synthesize 参数，熔断路径无法意外（或顺手）接上 LLM 合成。
    if (this.buildHandoffPkg && this.conversationRepo) {
      try {
        const workspacePath = this.workspaceGateway?.getWorkspacePath(params.conversationId);
        const pkg = await this.buildHandoffPkg(
          params.conversationId,
          params.otterId,
          buildManualHandoffOptions({
            inventoryDeps: this.buildStateInventoryDeps(params.conversationId, workspacePath),
            queryMessage: this.queryMessage,
            logger: this.logger,
            trigger: '熔断',
          }),
        );

        // 写入件②③④到 otter_context（借用式，首次 invoke 后删除）
        if (this.manageContext) {
          await this.manageContext.set(params.otterId, 'handoff_file_trail', pkg.fileTrail).catch(() => {});
          await this.manageContext.set(params.otterId, 'handoff_recency_window', pkg.recencyWindow).catch(() => {});
          await this.manageContext.set(params.otterId, 'handoff_state_inventory', pkg.stateInventory).catch(() => {});
        }

        this.logger.info('[circuit-break] Four-piece context injected', { otterId: params.otterId });
      } catch (pkgErr) {
        // 非致命：四件套注入失败不影响熔断重启
        this.logger.warn('[circuit-break] Four-piece injection failed, continuing with restart', {
          otterId: params.otterId,
          error: pkgErr instanceof Error ? pkgErr.message : String(pkgErr),
        });
      }
    }

    const restarted = await this.circuitBreak.executeCircuitBreakRestart(turnResult._circuitBreak, emitEvent);
    if (!restarted) {
      // D8 补偿删除：restart 失败时清理已写入的 context
      if (this.manageContext) {
        for (const key of ['handoff_file_trail', 'handoff_recency_window', 'handoff_state_inventory']) {
          await this.manageContext.delete(params.otterId, key).catch(() => {});
        }
      }
      return null;
    }
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
   * F20260819rscn + F20260824srst：自重启信号处理。
   * LLM 调用 restart_otter(self) 后，SDK 标记 _selfRestart 信号不执行 restart；
   * agent-invoker 执行 restart + 写 self_restart healing 事件 + 传 continuation message 递归 invoke。
   *
   * Why continuation message 而非原始消息：
   * "你重启自己"是一次性指令，执行一次即完成。递归调用时若传同一消息，
   * 新 session 的 LLM 会再次执行 → 无限循环。continuation message 告知"你已重启，请继续"，
   * 消除循环根因。tool-factory 层 + healing_events 上限判定提供纵深防御。
   */
  // eslint-disable-next-line max-lines-per-function, max-statements, complexity -- Phase 2: 手动重启+四件套注入+补偿删除
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
    currentMessageId: string,
  ): Promise<AgentTurnResult | null> {
    if (!signal) return null;
    const { otterId, summary } = signal;

    // F20260824srst 防循环（第二道防线）：当前 session 是否由自重启创建
    if (this.circuitBreak) {
      const isSelfRestartSession = await this.circuitBreak.isSessionSelfRestartCreated(otterId);
      if (isSelfRestartSession) {
        this.logger.warn('Self-restart blocked: current session was created by self-restart', { otterId });
        return null;
      }
    }

    let newSessionId: string;

    // F20260825hndf Phase 2：手动重启统一带四件套
    // 注入件②③④到 otter_context（借用式，首次 invoke 后删除）
    if (this.buildHandoffPkg && this.conversationRepo) {
      try {
        const workspacePath = this.workspaceGateway?.getWorkspacePath(params.conversationId);
        // 红线（审视 P1）：同熔断路径——buildManualHandoffOptions 类型上不接受
        // synthesize，手动重启永不接 LLM 合成（摘要用调用者/獭自己写的叙事）。
        const pkg = await this.buildHandoffPkg(
          params.conversationId,
          otterId,
          buildManualHandoffOptions({
            inventoryDeps: this.buildStateInventoryDeps(params.conversationId, workspacePath),
            queryMessage: this.queryMessage,
            logger: this.logger,
            trigger: '手动',
          }),
        );

        // 写入件②③④到 otter_context
        if (this.manageContext) {
          await this.manageContext.set(otterId, 'handoff_file_trail', pkg.fileTrail).catch(() => {});
          await this.manageContext.set(otterId, 'handoff_recency_window', pkg.recencyWindow).catch(() => {});
          await this.manageContext.set(otterId, 'handoff_state_inventory', pkg.stateInventory).catch(() => {});
        }

        this.logger.info('[self-restart] Four-piece context injected', { otterId });
      } catch (pkgErr) {
        // 非致命：四件套注入失败不影响重启
        this.logger.warn('[self-restart] Four-piece injection failed, continuing with restart', {
          otterId,
          error: pkgErr instanceof Error ? pkgErr.message : String(pkgErr),
        });
      }
    }

    try {
      const newSession = await this.manageSession.restartSession(otterId, summary);
      newSessionId = newSession.id;
      this.logger.info('Self-restart completed, re-invoking with new session', { otterId, newSessionId });
    } catch (restartErr) {
      // D8 补偿删除：restart 失败时清理已写入的 context
      if (this.manageContext) {
        for (const key of ['handoff_file_trail', 'handoff_recency_window', 'handoff_state_inventory']) {
          await this.manageContext.delete(otterId, key).catch(() => {});
        }
      }
      this.logger.error('Self-restart failed, continuing with current session', restartErr instanceof Error ? restartErr : new Error(String(restartErr)), { otterId });
      return null;
    }

    // F20260824srst 写 self_restart 事件（上限判定数据源）
    if (this.circuitBreak) {
      await this.circuitBreak.writeSelfRestartEvent(otterId, params.conversationId, newSessionId, currentMessageId).catch(err => {
        this.logger.error('self_restart event write failed (non-fatal)', err instanceof Error ? err : new Error(String(err)), { otterId, newSessionId });
      });
    }

    try {
      // F20260824srst 传 continuation message 而非原始消息（消除循环根因）
      const continuationMessage = summary
        ? `[系统] 你已完成自重启。前情摘要：${summary}\n请基于前情摘要继续当前工作。如果没有明确任务，请告知搭档你已重启完成，等待新指令。`
        : `[系统] 你已完成自重启，前世上下文已封存。请告知搭档你已重启完成，等待新指令。`;
      return await this.invokeConversationInner({
        ...params,
        userMessageContent: continuationMessage,
        retryCount: 0,
        manualRetry: false,
      });
    } catch (reinvokeErr) {
      this.logger.error('Self-restart re-invoke failed, falling back to interrupted state', reinvokeErr instanceof Error ? reinvokeErr : new Error(String(reinvokeErr)), {
        otterId: params.otterId,
        conversationId: params.conversationId,
      });
      return null;
    }
  }
}
