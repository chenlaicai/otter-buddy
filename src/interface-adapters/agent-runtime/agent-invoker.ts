/* eslint-disable max-lines */
import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import type { SSEEvent } from "@contract/sse/events";
import { runWithTrace, getTraceContext, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort, InvokeOutcome, InvokeOutcomeRecord } from "@usecases/ports/agent-metrics-port";
import { toRetryLabel } from "@usecases/ports/agent-metrics-port";

/** 携带工具调用计数的 Error（abort 路径跨层传递用） */
type ErrorWithToolCallCount = Error & {
  _toolCallCount?: number;
  /** F20260814mtrc：guard abort 路径的 outputGuard 元数据（含首字节样本） */
  _outputGuardMetadata?: { firstByteLatencyMs?: number };
  /** F20260814mtrc：失败路径的模型别名（err 路径 result 不可达，PR 审视 P1 修复） */
  _modelAlias?: string;
};

/** invoke 结果形状（F20260814mtrc：补 metrics 透传字段，替换散落的内联类型） */
interface InvokeResultShape {
  text: string;
  tokenUsage?: { input: number; output: number };
  ctxTokens?: number;
  ctxMax?: number;
  modelAlias?: string;
  sessionRebuilt?: boolean;
  outputGuardMetadata?: { totalLength: number; tripped: boolean; reason?: string; firstByteLatencyMs?: number };
}

/** Agent 对话调用结果 */
export interface ConversationInvokeResult {
  messageId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  /** Turn 关闭后的聚合发言石目标 */
  aggregatedTargets?: string[];
}

/** Agent invocation exit reason classification */
type ExitReason =
  | { kind: 'user_abort'; toolCallCount: number }
  | { kind: 'guard_abort'; guardReason: string; toolCallCount: number }
  | { kind: 'api_error'; errorMessage: string; toolCallCount: number }
  | { kind: 'no_speak'; toolCallCount: number };

/** Pi 事件 -> SSE 事件映射 */
/** 从 message_end 事件提取 assistant 内容块（过滤 user/toolResult） */
function extractAssistantContent(e: AgentStreamEvent): { type: "toolcall" | "text"; blocks: Array<Record<string, unknown>> } | null {
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = inner ?? (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const role = msg?.role as string | undefined;
  const content = msg?.content as Array<Record<string, unknown>> | undefined;
  if (!content || role === "user" || role === "toolResult") return null;
  const toolCalls = content.filter((c) => c.type === "toolCall");
  if (toolCalls.length > 0) return { type: "toolcall", blocks: toolCalls };
  const textBlocks = content.filter((c) => c.type === "text");
  return textBlocks.length > 0 ? { type: "text", blocks: textBlocks } : null;
}

/** R20260810piab 遗漏 1：SDK 结构化事件 → SSE 事件映射（auto_retry / compaction，之前被丢弃） */
const SDK_EVENT_SSE_MAP: Record<string, string> = {
  auto_retry_start: "agent.retry_start",
  auto_retry_end: "agent.retry_end",
  compaction_start: "agent.compaction_start",
  compaction_end: "agent.compaction_end",
};

/** 从 SDK 事件提取结构化字段（透传到 SSE data） */
function extractSdkEventFields(e: AgentStreamEvent): Record<string, unknown> {
  switch (e.type) {
    case "auto_retry_start":
      return { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage };
    case "auto_retry_end":
      return { success: e.success, attempt: e.attempt, finalError: e.finalError };
    case "compaction_start":
      return { reason: e.reason };
    case "compaction_end":
      return { reason: e.reason, aborted: e.aborted, willRetry: e.willRetry, errorMessage: e.errorMessage };
    default:
      return {};
  }
}

function mapToSSEEvent(e: AgentStreamEvent): SSEEvent | null {
  const sseEventName = SDK_EVENT_SSE_MAP[e.type];
  if (sseEventName) {
    return { event: sseEventName, data: extractSdkEventFields(e) };
  }
  switch (e.type) {
    case "tool_execution_end":
      return { event: "tool.result", data: { toolName: e.name ?? e.toolName ?? "", result: e.result } };
    case "message_end": {
      const extracted = extractAssistantContent(e);
      if (!extracted) return null;
      const event = extracted.type === "toolcall" ? "assistant_toolcall" : "assistant_text";
      return { event, data: { content: extracted.blocks } };
    }
    case "turn_end":
      return null;
    case "agent_end":
      return { event: "agent.idle", data: {} };
    default:
      return null;
  }
}

/** 从 message_end 事件提取可存储的 MessageEventInput */
function mapMessageEndEvent(e: AgentStreamEvent, messageId: string): MessageEventInput | null {
  const extracted = extractAssistantContent(e);
  if (!extracted) return null;
  const eventType = extracted.type === "toolcall" ? "assistant_toolcall" : "assistant_text";
  return { messageId, eventType, payload: { content: extracted.blocks } };
}

/** Pi 事件 -> MessageEventInput 映射（持久化到 DB） */
function mapToMessageEventInput(
  e: AgentStreamEvent,
  messageId: string,
): MessageEventInput | null {
  switch (e.type) {
    case "tool_execution_end":
      return { messageId, eventType: "tool_result", payload: { name: e.name ?? e.toolName, result: e.result } };
    case "message_end":
      return mapMessageEndEvent(e, messageId);
    default:
      if (String(e.type).includes("error")) {
        return { messageId, eventType: "error", payload: { message: String(e.error ?? e.message ?? "Unknown error") } };
      }
      return null;
  }
}

export class AgentInvoker {
  /** Messages explicitly aborted by the user (written only by abort()) */
  private readonly userAbortedMessages = new Set<string>();
  /** Messages already sent to a terminal state (abort/fail), prevents double-terminal */
  private readonly terminalMessages = new Set<string>();
  /**
   * F20260814mtrc PR 审视 P0-1 修复：已记录 metrics 的 attempt 键（messageId:retryCount）。
   * 防御 routeByReason 抛错 → 外层 catch 重入 classifyAndRoute 的双计；
   * 键在 invokeConversationInner / retryInvokeOnSameMessage 的 finally 中清理（重入只可能发生在这个窗口内）。
   */
  private readonly recordedAttempts = new Set<string>();

  // eslint-disable-next-line max-params -- AgentInvoker 依赖较多，参数数量由 DI 框架决定
  constructor(
    private readonly agentInvoke: AgentInvokePort,
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
  ) {}

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
  }): Promise<ConversationInvokeResult> {
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
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, userMessageContent, senderId, onSSEEvent, retryCount = 0, manualRetry = false } = params;
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
      try {
        try {
          const { result, toolCallCount } = await this.executeAgentInvocation({
            otterId, userMessageContent, dynamicContext, conversationId, messageId: message.id, emitEvent,
          });
          return await this.classifyAndRoute({
            messageId: message.id, otterId, senderId, result, toolCallCount,
            startTime, emitEvent, onSSEEvent, retryCount, userMessageContent, conversationId,
            manualRetry,
          });
        } catch (err) {
          /** 重入 classifyAndRoute（classifyAndRoute 自身抛错时）；attempt 去重键防 metrics 双计 */
          const toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? 0;
          return await this.classifyAndRoute({
            messageId: message.id, otterId, senderId, err, toolCallCount,
            startTime, emitEvent, onSSEEvent, retryCount, userMessageContent, conversationId,
            manualRetry,
          });
        }
      } finally {
        this.recordedAttempts.delete(this.attemptKey(message.id, retryCount));
      }
    });
  }

  /**
   * 执行 Agent 调用。
   * 返回 result + 事件流中跟踪的 toolCallCount（供 abort body 使用）。
   */
  private async executeAgentInvocation(params: {
    otterId: string;
    userMessageContent: string;
    dynamicContext: DynamicContext;
    conversationId: string;
    messageId: string;
    emitEvent: (event: SSEEvent) => void;
  }): Promise<{ result: InvokeResultShape; toolCallCount: number }> {
    let toolCallCount = 0;
    /** F20260814mtrc：工具执行按 toolCallId 配对计时（对齐 circuit-breaker 的防御式配对） */
    const toolStarts = new Map<string, number>();
    this.logger.debug('Calling agentInvoke.invoke', { otterId: params.otterId, messageId: params.messageId });
    const result = await this.agentInvoke.invoke(params.otterId, params.userMessageContent, {
      dynamicContext: params.dynamicContext,
      conversationId: params.conversationId,
      messageId: params.messageId,
      onEvent: (e: AgentStreamEvent) => {
        this.logger.debug('Agent event received', { messageId: params.messageId, eventType: e.type, toolName: e.name ?? e.toolName });
        this.recordStreamEventMetrics(e, toolStarts);
        if (e.type === "tool_execution_start") {
          toolCallCount++;
        }
        /** 所有事件如实推送到订阅者（event 就是 event，不抑制） */
        const sse = mapToSSEEvent(e);
        if (sse) {
          params.emitEvent({ event: sse.event, data: { ...sse.data, messageId: params.messageId } });
        }
        if (e.type === "tool_execution_end" && (e.name ?? e.toolName) === "speak") {
          /** speak 工具执行完毕，记录日志 */
          this.logger.debug('speak tool executed', { messageId: params.messageId });
        }
        /** 所有事件如实持久化（event 就是 event，不抑制） */
        const evt = mapToMessageEventInput(e, params.messageId);
        if (evt) this.sendMessage.appendEvent(evt).catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to persist message event for ${params.messageId}: ${m}`);
        });
      },
    });
    return { result, toolCallCount };
  }

  /**
   * 完成 Agent 调用：记录日志、发送 SSE 事件。
   */
  private async completeAgentInvocation(params: {
    otterId: string;
    conversationId: string;
    messageId: string;
    senderId: string;
    result: InvokeResultShape;
    startTime: number;
    emitEvent: (event: SSEEvent) => void;
    aggregatedTargets?: string[];
    /** F20260814mtrc：显式传入才记录 metrics——成功路径必传；
     * user_abort 的 speaking 收尾不传（recordFailedAttempt 已按 user_abort 记过，防双计）。
     * err 随行：err 收尾路径的 model/firstByte 从 error 附带字段回退（PR 审视修复） */
    outcomeMeta?: { outcome: InvokeOutcome; retryCount: number; manualRetry: boolean; attemptStartTime: number; err?: unknown };
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, messageId, result, startTime, emitEvent, aggregatedTargets, outcomeMeta } = params;

    /** 消息已在 invokeConversation 中通过 sendMessage.complete() 完成，此处发 SSE 事件和清理状态 */

    /** D2-fix: 清理 stale abort 标记（竞态：abort 被调用但 invoke 成功完成） */
    this.userAbortedMessages.delete(messageId);
    this.terminalMessages.delete(messageId);

    const duration = Date.now() - startTime;

    // F20260814mtrc：success 在此记录——tryCompleteSpeaking 早返回会绕过 classifyAndRoute，
    // 此处才是成功路径的汇合点（duration 用 attempt 级时间；SSE 展示仍用链级 startTime）。
    // PR 审视修复：fire-and-forget——recordAttempt 内含 DB 读，不得阻塞 message.complete SSE
    if (outcomeMeta) {
      void this.recordAttempt({
        messageId, otterId, result, err: outcomeMeta.err,
        outcome: outcomeMeta.outcome,
        retryCount: outcomeMeta.retryCount,
        manualRetry: outcomeMeta.manualRetry,
        startTime: outcomeMeta.attemptStartTime,
      });
    }

    // 记录 Agent 调用完成日志
    this.logger.info('Agent invocation completed', {
      otterId,
      conversationId,
      messageId,
      duration,
      tokenUsage: result.tokenUsage,
      status: 'success',
    });

    /** F20260808ctxw：SSE ctx 口径 = 上下文窗口占用（末次 LLM 调用），与落库值同源 */
    const ctxTokens = result.ctxTokens;
    /** 从 DB 获取 speak 存储的 body，通过 SSE 直接带给前端（避免前端额外 API 调用） */
    const msg = await this.queryMessage.getMessageById(messageId);
    /** 获取 otter 名称（与 message.start 一致，防止 liveMeta 丢失时前端回退到 "Otter"） */
    const otter = await this.queryOtter.getById(otterId);
    emitEvent({
      event: "message.complete",
      data: {
        messageId,
        otterId,
        otterName: otter?.name ?? otterId,
        body: msg?.body ?? '',
        turnId: msg?.turnId ?? '',
        duration: `${(duration / 1000).toFixed(1)}s`,
        ctx: ctxTokens,
        ctxMax: result.ctxMax,
      },
    });

    /** D5-fix: turn.complete 在 message.complete 之后发出（设计文档事件顺序） */
    emitEvent({ event: "turn.complete", data: {} });

    // 广播消息到 Web 和飞书
    if (this.messageBroadcaster && msg) {
      this.messageBroadcaster.broadcast(msg).catch(err => {
        this.logger.error("Failed to broadcast message", err instanceof Error ? err : undefined, {
          messageId,
          conversationId,
        });
      });
    }

    return { messageId, duration, tokenUsage: result.tokenUsage, aggregatedTargets };
  }

  /** Post-invocation: classify exit reason and route to appropriate handler */
  private async classifyAndRoute(p: {
    messageId: string; otterId: string; senderId: string;
    result?: InvokeResultShape;
    err?: unknown;
    toolCallCount: number; startTime: number;
    /** F20260814mtrc：attempt 级计时起点（speak-retry 复用外层 startTime 是链级口径，metrics 需 attempt 级） */
    attemptStartTime?: number;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    manualRetry?: boolean;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, senderId, result, err, toolCallCount, startTime, emitEvent, onSSEEvent, retryCount, manualRetry, userMessageContent, conversationId } = p;

    // 1. Speaking guard: content delivery takes priority over everything
    const speakingHandled = await this.tryCompleteSpeaking({
      messageId, otterId, senderId, conversationId, result, err, startTime, emitEvent,
      retryCount: retryCount ?? 0, manualRetry: manualRetry ?? false,
      attemptStartTime: p.attemptStartTime ?? startTime,
    });
    if (speakingHandled) return speakingHandled;

    // 2. Classify exit reason and route
    const reason = this.classifyExit({ messageId, result, err, toolCallCount });

    // F20260814mtrc：失败 attempt 在分类后、路由前记录（duration 不含后续重试链的 await）
    this.recordFailedAttempt(reason, {
      messageId, otterId, result, err,
      retryCount: retryCount ?? 0,
      manualRetry: manualRetry ?? false,
      attemptStartTime: p.attemptStartTime ?? startTime,
    });

    return this.routeByReason(reason, { messageId, otterId, senderId, result, startTime, emitEvent, onSSEEvent, retryCount, manualRetry, userMessageContent, conversationId });
  }

  /** Try to complete a speaking message; returns result if handled, undefined otherwise */
  private async tryCompleteSpeaking(p: {
    messageId: string; otterId: string; senderId: string; conversationId?: string;
    result?: InvokeResultShape;
    err?: unknown;
    startTime: number; emitEvent: (event: SSEEvent) => void;
    retryCount: number; manualRetry: boolean;
    attemptStartTime: number;
  }): Promise<ConversationInvokeResult | undefined> {
    const msg = await this.queryMessage.getMessageById(p.messageId);
    if (msg?.status !== 'speaking') return undefined;
    if (p.result) {
      const cr = await this.sendMessage.complete(p.messageId, {
        contextTokens: p.result.ctxTokens, contextTokensMax: p.result.ctxMax,
      });
      return this.completeAgentInvocation({
        otterId: p.otterId, conversationId: p.conversationId ?? '', messageId: p.messageId, senderId: p.senderId,
        result: p.result, startTime: p.startTime, emitEvent: p.emitEvent, aggregatedTargets: cr.turnClose.aggregatedTargets,
        outcomeMeta: { outcome: "success", retryCount: p.retryCount, manualRetry: p.manualRetry, attemptStartTime: p.attemptStartTime },
      });
    }
    try {
      const cr = await this.sendMessage.complete(p.messageId);
      /**
       * PR 审视修复：err 路径 + 消息已 speaking（speak 已交付但 invoke 抛错/被中断）——
       * 早返回会绕过 classifyAndRoute，此前整条 attempt 漏记。此处按退出分类补记 outcome。
       */
      const outcome = this.exitKindToOutcome(
        this.classifyExit({ messageId: p.messageId, err: p.err, toolCallCount: 0 }).kind,
        p.retryCount,
      );
      return this.completeAgentInvocation({
        otterId: p.otterId, conversationId: p.conversationId ?? '', messageId: p.messageId, senderId: p.senderId,
        result: { text: '' }, startTime: p.startTime, emitEvent: p.emitEvent, aggregatedTargets: cr.turnClose?.aggregatedTargets,
        outcomeMeta: { outcome, retryCount: p.retryCount, manualRetry: p.manualRetry, attemptStartTime: p.attemptStartTime, err: p.err },
      });
    } catch (err) {
      this.logger.warn('tryCompleteSpeaking: sendMessage.complete failed, falling through to classify', { messageId: p.messageId, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /** Route by classified exit reason */
  private routeByReason(reason: ExitReason, p: {
    messageId: string; otterId: string; senderId: string;
    result?: InvokeResultShape;
    startTime: number; emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number; manualRetry?: boolean;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, senderId, result, startTime, emitEvent, onSSEEvent, retryCount, manualRetry, userMessageContent, conversationId } = p;
    switch (reason.kind) {
      case 'user_abort':
        return this.handleUserAbort({ messageId, otterId, senderId, reason, startTime, emitEvent, conversationId });
      case 'guard_abort':
        return this.routeGuardAbort({ messageId, otterId, senderId, reason, startTime, emitEvent, onSSEEvent, retryCount, manualRetry, userMessageContent, conversationId, result });
      case 'api_error':
        return this.routeApiError({ messageId, otterId, reason, startTime, emitEvent });
      case 'no_speak':
        return this.handleSpeakRetry({ messageId, otterId, conversationId: conversationId ?? '', userMessageContent: userMessageContent ?? '', senderId, emitEvent, onSSEEvent, retryCount: retryCount ?? 0, manualRetry: manualRetry ?? false, startTime, tokenUsage: result?.tokenUsage, toolCallCount: reason.toolCallCount });
      default:
        return Promise.resolve({ messageId, duration: Date.now() - startTime });
    }
  }

  /** Classify the exit reason from invocation result or error */
  private classifyExit(p: {
    messageId: string;
    result?: { text: string; tokenUsage?: { input: number; output: number }; ctxTokens?: number; ctxMax?: number };
    err?: unknown;
    toolCallCount: number;
  }): ExitReason {
    if (this.userAbortedMessages.has(p.messageId)) {
      return { kind: 'user_abort', toolCallCount: p.toolCallCount };
    }

    const guardReason = this.extractGuardReason(p.messageId, p.result, p.err);
    if (guardReason) {
      return { kind: 'guard_abort', guardReason, toolCallCount: p.toolCallCount };
    }

    if (p.err) {
      const msg = p.err instanceof Error ? p.err.message : String(p.err);
      return { kind: 'api_error', errorMessage: msg, toolCallCount: p.toolCallCount };
    }

    return { kind: 'no_speak', toolCallCount: p.toolCallCount };
  }

  /** Extract guard abort reason from result or error (single source of truth) */
  private extractGuardReason(messageId: string, result?: unknown, err?: unknown): string | undefined {
    const fromResult = (result as Record<string, unknown>)?._guardAbortReason as string | undefined;
    if (fromResult) return fromResult;
    const fromErr = (err as { _guardAbortReason?: string })?._guardAbortReason;
    if (fromErr) return fromErr;
    return this.agentInvoke.getInternalAbortReason(messageId);
  }

  /** Handle user abort: speaking guard → abort terminal */
  private async handleUserAbort(p: {
    messageId: string; otterId: string; senderId: string;
    reason: ExitReason & { kind: 'user_abort' };
    startTime: number; emitEvent: (event: SSEEvent) => void;
    conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, senderId, startTime, emitEvent, conversationId } = p;

    const completedIfSpeaking = await this.completeSpeakingMessage(
      messageId, otterId, emitEvent, senderId, conversationId, startTime,
    );
    if (completedIfSpeaking) return { messageId, duration: Date.now() - startTime };

    return this.abortTerminal({ messageId, otterId, senderId, startTime, emitEvent, conversationId, toolCallCount: p.reason.toolCallCount }, 'user');
  }

  /** Route guard abort: degenerate retry → auto-retry → abort terminal */
  private async routeGuardAbort(p: {
    messageId: string; otterId: string; senderId: string;
    reason: ExitReason & { kind: 'guard_abort' };
    startTime: number; emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number; manualRetry?: boolean;
    userMessageContent?: string; conversationId?: string;
    result?: InvokeResultShape;
  }): Promise<ConversationInvokeResult> {
    const { guardReason, toolCallCount } = p.reason;
    const retryCount = p.retryCount ?? 0;

    if (guardReason === 'degenerate_output' && retryCount === 0) {
      return this.handleDegenerateRetry({
        messageId: p.messageId, otterId: p.otterId, senderId: p.senderId,
        result: p.result ?? { text: '' }, toolCallCount,
        startTime: p.startTime, emitEvent: p.emitEvent,
        onSSEEvent: p.onSSEEvent, retryCount,
        userMessageContent: p.userMessageContent, conversationId: p.conversationId,
      });
    }

    if (retryCount === 0 && this.isRetryableGuardAbort(guardReason)) {
      this.logger.info('Auto-retry on guard abort', { messageId: p.messageId, otterId: p.otterId, guardReason });
      /** F20260814mtrc：重试意图计数在 recordFailedAttempt（分类点，去重键保护） */
      return this.handleAutoRetry(p, guardReason);
    }

    return this.abortTerminal({ ...p, toolCallCount: p.reason.toolCallCount }, 'guard', guardReason);
  }

  /** Route API error: SDK 已内置 auto-retry（maxRetries=4，见 pi-session-factory settingsManager），耗尽后直接 fail terminal */
  private async routeApiError(p: {
    messageId: string; otterId: string;
    reason: ExitReason & { kind: 'api_error' };
    startTime: number; emitEvent: (event: SSEEvent) => void;
  }): Promise<ConversationInvokeResult> {
    const { errorMessage } = p.reason;
    return this.failTerminal(p, errorMessage);
  }

  /** Abort terminal: build body → sendMessage.abort → emit message.aborted */
  private async abortTerminal(p: {
    messageId: string; otterId: string; senderId: string;
    startTime: number; emitEvent: (event: SSEEvent) => void;
    conversationId?: string;
    toolCallCount?: number;
  }, kind: 'user' | 'guard', guardReason?: string): Promise<ConversationInvokeResult> {
    const { messageId, otterId, senderId, startTime, emitEvent } = p;
    if (this.terminalMessages.has(messageId)) return { messageId, duration: Date.now() - startTime };

    this.terminalMessages.add(messageId);
    this.userAbortedMessages.delete(messageId);

    const toolCallCount = p.toolCallCount || this.agentInvoke.getToolCallCount(otterId, messageId);
    const body = await this.buildAbortBody(kind, guardReason, toolCallCount, otterId);
    try {
      await this.sendMessage.abort(messageId, { body, talkingStonePassedTo: senderId ? [senderId] : [] });
    } catch { /* ignore */ }

    const otter = await this.queryOtter.getById(otterId);
    emitEvent({ event: 'message.aborted', data: { messageId, body, otterId, otterName: otter?.name } });

    return { messageId, duration: Date.now() - startTime };
  }

  /** Fail terminal: sendMessage.fail → emit error */
  private async failTerminal(p: {
    messageId: string; otterId: string;
    startTime: number; emitEvent: (event: SSEEvent) => void;
  }, errorMessage: string): Promise<ConversationInvokeResult> {
    const { messageId, otterId, startTime, emitEvent } = p;
    if (this.terminalMessages.has(messageId)) return { messageId, duration: Date.now() - startTime };

    this.terminalMessages.add(messageId);

    try {
      await this.sendMessage.fail(messageId, `[错误] ${errorMessage}`);
    } catch { /* ignore */ }

    emitEvent({ event: 'error', data: { message: errorMessage, messageId, otterId } });

    return { messageId, duration: Date.now() - startTime };
  }

  /** Auto-retry: fail current message → re-invoke */
  private async handleAutoRetry(p: {
    messageId: string; otterId: string; senderId: string;
    startTime: number; emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number; manualRetry?: boolean;
    userMessageContent?: string; conversationId?: string;
  }, reason: string): Promise<ConversationInvokeResult> {
    const { messageId, otterId, senderId, startTime, emitEvent, onSSEEvent, userMessageContent, conversationId } = p;
    if (!conversationId || !userMessageContent) {
      this.logger.warn('Auto-retry skipped: missing conversationId or userMessageContent', { messageId, otterId });
      return this.failTerminal(p, this.buildRetryFailBody(reason));
    }

    const failBody = `[系统] ${this.buildRetryFailBody(reason)}, 正在自动重试`;

    try { await this.sendMessage.fail(messageId, failBody); } catch { /* ignore */ }
    const otter = await this.queryOtter.getById(otterId);
    emitEvent({ event: 'message.failed', data: { messageId, otterId, otterName: otter?.name ?? otterId, body: failBody } });

    this.userAbortedMessages.delete(messageId);

    await this.invokeConversation({
      otterId, conversationId,
      userMessageContent,
      senderId, retryCount: 1,
      manualRetry: p.manualRetry,
      onSSEEvent,
    });

    return { messageId, duration: Date.now() - startTime };
  }

  /** Check if guard abort reason is retryable */
  private isRetryableGuardAbort(reason: string): boolean {
    if (reason === 'degenerate_output') return false;
    if (reason === 'streaming_timeout') return true;
    if (reason === 'first_byte_timeout') return true;
    if (reason.startsWith('circuit_break:')) return true;
    return false;
  }

  /**
   * F20260806cbsx: 若消息已 speaking（speak 已提交 body），走 complete 收尾。
   * 返回 true 表示已处理（调用方应跳过 abort 路径）。
   */
  // eslint-disable-next-line max-params
  private async completeSpeakingMessage(
    messageId: string,
    otterId: string,
    emitEvent: (event: SSEEvent) => void,
    senderId?: string,
    conversationId?: string,
    startTime?: number,
  ): Promise<boolean> {
    if (!conversationId || startTime === undefined) return false;
    const msg = await this.queryMessage.getMessageById(messageId);
    if (msg?.status !== "speaking") return false;
    try {
      const cr = await this.sendMessage.complete(messageId);
      /** F20260814mtrc：不传 outcomeMeta——recordFailedAttempt 已按 user_abort 记过，此处防双计 */
      await this.completeAgentInvocation({
        otterId, conversationId, messageId,
        senderId: senderId ?? '',
        result: { text: "" },
        startTime, emitEvent,
        aggregatedTargets: cr.turnClose?.aggregatedTargets,
      });
      return true;
    } catch {
      /** TOCTOU 竞态：complete 前状态已变，降级走 abort 路径 */
      return false;
    }
  }

  /** 构造自动重试的过渡态消息 */
  private buildRetryFailBody(reason: string): string {
    if (reason === "streaming_timeout") return "生成过程超时";
    if (reason === "first_byte_timeout") return "模型响应超时";
    if (reason.startsWith("circuit_break:")) return "工具调用异常";
    if (reason === "api_error") return "模型服务异常";
    return "执行异常";
  }

  /** Build abort body: user abort vs guard abort */
  private async buildAbortBody(kind: 'user' | 'guard', guardReason: string | undefined, toolCallCount: number, _otterId: string): Promise<string> {
    if (kind === 'guard') {
      if (guardReason === 'degenerate_output') return '[系统保护] 检测到输出内容异常重复，已自动中断。';
      if (guardReason === 'streaming_timeout') return '[系统保护] 生成过程超时，已自动中断。';
      if (guardReason === 'first_byte_timeout') return '[系统保护] 模型响应超时，已自动中断。';
      if (guardReason?.startsWith('circuit_break:')) {
        if (guardReason.includes('event_timeout')) return '[系统保护] 单次工具调用超时，已自动中断。';
        return '[系统保护] 检测到工具调用异常循环，已自动中断。';
      }
      return '[系统保护] 输出异常，已自动中断。';
    }

    // User abort
    const partnerLabel = this.settingsRepo ? ((await this.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    return `[${partnerLabel}中断] 经过 ${toolCallCount} 次工具调用后，${partnerLabel}强制中断了当前发言。`;
  }

  /**
   * 重试通用逻辑：fail（过渡态）+ sendSystem（提醒）+ invokeConversation（重试）。
   * handleDegenerateRetry 和 handleSpeakRetry 共用。
   */
  private async executeRetryWithSystemReminder(params: {
    messageId: string; otterId: string; conversationId: string;
    senderId: string; failBody: string; retryMsg: string;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    tokenUsage?: { input: number; output: number };
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, conversationId, senderId, failBody, retryMsg, emitEvent, tokenUsage } = params;
    const startTime = Date.now();

    /** 1. fail 当前消息（前端展示过渡态） */
    try { await this.sendMessage.fail(messageId, failBody); } catch { /* ignore */ }
    const otter = await this.queryOtter.getById(otterId);
    const otterName = otter?.name ?? otterId;
    emitEvent({ event: "message.failed", data: { messageId, otterId, otterName, body: failBody } });

    /** 2. 注入系统提醒（DB + LLM 上下文） */
    let sysMsg;
    try {
      sysMsg = await this.sendMessage.sendSystem(conversationId, retryMsg);
      emitEvent({ event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body, seq: sysMsg.sequenceNum } });
    } catch (err) {
      /** sendSystem 失败：降级为直接 abort，避免 double-terminal 事件 */
      this.logger.warn('sendSystem failed during retry, falling back to abort', { messageId, otterId, error: err instanceof Error ? err.message : String(err) });
      this.terminalMessages.add(messageId);
      const body = "[系统保护] 检测到输出异常重复，已自动中断。";
      try { await this.sendMessage.abort(messageId, { body, talkingStonePassedTo: [senderId] }); } catch { /* ignore */ }
      emitEvent({ event: "message.aborted", data: { messageId, body, otterId, otterName } });
      return { messageId, duration: Date.now() - startTime };
    }

    /** 3. 重试（retryCount=1 标记已重试，再犯走终态） */
    const retryResult = await this.invokeConversation({
      otterId, conversationId,
      userMessageContent: retryMsg,
      senderId, retryCount: 1,
      onSSEEvent: params.onSSEEvent,
    });
    this.logger.info('Retry completed', { messageId, otterId, retryTokenUsage: retryResult.tokenUsage });
    return { ...retryResult, tokenUsage: retryResult.tokenUsage ?? tokenUsage };
  }

  /**
   * degenerate_output 梯度介入：abort + 系统提醒 + 重试一次。再犯才落终态。
   * 仅 retryCount===0 时调用；重试时传 retryCount=1，再犯走 abort 终态。
   */
  private async handleDegenerateRetry(p: {
    messageId: string; otterId: string; senderId: string;
    result: { text: string; tokenUsage?: { input: number; output: number } };
    toolCallCount: number; startTime: number;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    this.logger.info('Degenerate output retry triggered', { messageId: p.messageId, otterId: p.otterId });
    return this.executeRetryWithSystemReminder({
      messageId: p.messageId, otterId: p.otterId, conversationId: p.conversationId ?? "",
      senderId: p.senderId, emitEvent: p.emitEvent, onSSEEvent: p.onSSEEvent,
      failBody: "[系统] 检测到输出异常重复，正在自我纠正",
      retryMsg: "[系统提醒] 你上一轮陷入重复循环，分析已在上下文中，不要重新推理，直接基于已有结论调用 speak 输出。",
      tokenUsage: p.result.tokenUsage,
    });
  }

  /**
   * speak 重试：agent 未调 speak 就结束时，注入系统提醒并触发重试。
   * 最多重试 1 次。第二次失败时发言石额外包含 user。
   *
   * Why: 重试时复用同一消息 ID（单消息重试），用户只看到一条连续消息。
   * 旧行为（3 条消息：失败 + 系统提醒 + 新消息）作为降级路径保留。
   */
  private async handleSpeakRetry(params: {
    messageId: string;
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount: number;
    manualRetry: boolean;
    startTime: number;
    tokenUsage?: { input: number; output: number };
    toolCallCount?: number;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, conversationId, senderId, emitEvent, retryCount, manualRetry, startTime, tokenUsage, toolCallCount } = params;
    this.logger.info('Speak retry triggered', { messageId, otterId, retryCount });

    if (retryCount === 0) {
      // 1. 内部标记消息失败（不发 SSE 事件，用户不可见）
      const failBody = "[系统] 未调用 speak 工具结束发言";
      /** 为什么 catch 吞掉异常：消息可能已被用户 abort 标记为终态（aborted），此时 fail() 被 canFailMessage 拒绝。吞掉是安全的——后续 prepareForRetry 会检查状态并按需降级。 */
      try { await this.sendMessage.fail(messageId, failBody); } catch { /* 幂等：终态消息跳过 fail */ }

      // 2. 重置消息为可重试状态（failed → streaming）
      try {
        await this.sendMessage.prepareForRetry(messageId);
      } catch (err) {
        // prepareForRetry 失败：降级为原有行为（发 message.failed + 系统提醒 + 新消息）
        this.logger.warn('prepareForRetry failed, falling back to legacy retry', {
          messageId, error: err instanceof Error ? err.message : String(err),
        });
        return this.executeRetryWithSystemReminder({
          messageId, otterId, conversationId, senderId, emitEvent,
          onSSEEvent: params.onSSEEvent,
          failBody,
          retryMsg: this.buildSpeakRetryMsg(toolCallCount),
          tokenUsage,
        });
      }

      // 3. 重试（复用同一 messageId，classifyAndRoute 处理所有退出路径）
      const retryMsg = this.buildSpeakRetryMsg(toolCallCount);
      const retryResult = await this.retryInvokeOnSameMessage({
        otterId, conversationId, userMessageContent: retryMsg,
        senderId, messageId, emitEvent, onSSEEvent: params.onSSEEvent,
        retryCount: 1, manualRetry, startTime,
      });

      this.logger.info('Speak retry completed (seamless)', { messageId, otterId });
      return { ...retryResult, tokenUsage: retryResult.tokenUsage ?? tokenUsage };
    }

    // 第二次仍失败：发 message.failed（用户可见）
    this.logger.warn('Speak retry exhausted, failing message', { messageId, otterId, conversationId });
    const otter = await this.queryOtter.getById(otterId);
    const otterName = otter?.name ?? otterId;
    const failBody = "[系统] 重试后仍未调用 speak 工具";
    try {
      await this.sendMessage.fail(messageId, failBody, [senderId]);
    } catch { /* 幂等：降级路径中消息可能仍处于 failed 状态（prepareForRetry 失败），二次 fail 被拒绝是正常的 */ }

    const duration = Date.now() - startTime;
    emitEvent({ event: "message.failed", data: { messageId, otterId, otterName, body: failBody } });

    return { messageId, duration, tokenUsage };
  }

  /**
   * 复用同一 messageId 重试 Agent 调用。
   * 与 invokeConversation 的区别：不创建新消息，不发 message.start 事件。
   * 退出分类复用 classifyAndRoute，保证 user abort / guard abort / api error 路径一致。
   */
  private async retryInvokeOnSameMessage(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    messageId: string;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount: number;
    manualRetry: boolean;
    startTime: number;
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, userMessageContent, senderId, messageId, emitEvent, onSSEEvent, retryCount, manualRetry, startTime } = params;
    /** F20260814mtrc：attempt 级计时——外层 startTime 是链级口径，metrics 用 attempt 入口时间防直方图双计 */
    const attemptStartTime = Date.now();

    const dynamicContext = await this.buildDynamicContext(otterId);
    await this.injectWorkspacePath(dynamicContext, conversationId);

    // F20260814mtrc：messageId 进 trace scope（此路径不经 invokeConversation）
    return runWithTrace({ messageId }, async () => {
      try {
        try {
          const { result, toolCallCount } = await this.executeAgentInvocation({
            otterId, userMessageContent, dynamicContext, conversationId, messageId, emitEvent,
          });

          // Why: 复用 classifyAndRoute 做退出分类，覆盖 user abort / guard abort / no_speak / api error
          return await this.classifyAndRoute({
            messageId, otterId, senderId, result, toolCallCount,
            startTime, attemptStartTime, emitEvent, onSSEEvent, retryCount, manualRetry,
            userMessageContent, conversationId,
          });
        } catch (err) {
          /** 重入 classifyAndRoute（classifyAndRoute 自身抛错时）；attempt 去重键防 metrics 双计 */
          const toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? 0;
          return await this.classifyAndRoute({
            messageId, otterId, senderId, err, toolCallCount,
            startTime, attemptStartTime, emitEvent, onSSEEvent, retryCount, manualRetry,
            userMessageContent, conversationId,
          });
        }
      } finally {
        this.recordedAttempts.delete(this.attemptKey(messageId, retryCount));
      }
    });
  }

  /** 构建 speak 重试的系统提醒消息 */
  private buildSpeakRetryMsg(toolCallCount?: number): string {
    const isThinkingOnly = (toolCallCount ?? 0) === 0;
    return isThinkingOnly
      ? "[系统提醒] 你上一轮没有调用任何工具。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。"
      : "[系统提醒] 你上一次发言没有调用 speak 工具就结束了。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。";
  }

  /** 中断 Agent 生成（UA-2: 调用 AgentInvokePort.abort()）；标记按 messageId 键控 */
  abort(otterId: string, messageId: string): void {
    this.userAbortedMessages.add(messageId);
    this.agentInvoke.abort(otterId, messageId);
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

  /** ExitReason.kind → outcome 枚举映射（tryCompleteSpeaking err 收尾复用） */
  private exitKindToOutcome(kind: ExitReason["kind"], retryCount: number): InvokeOutcome {
    switch (kind) {
      case 'user_abort':
        return 'user_abort';
      case 'guard_abort':
        return 'guard_abort';
      case 'api_error':
        return 'api_error';
      default:
        return retryCount === 0 ? 'no_speak_retry' : 'no_speak_failed';
    }
  }

  /** attempt 记录去重键（PR 审视 P0-1：防 classifyAndRoute 重入双计） */
  private attemptKey(messageId: string, retryCount: number): string {
    return `${messageId}:${retryCount}`;
  }

  /** metrics 安全壳：任何异常不得进入主流程（PR 审视修复） */
  private recordRetrySafe(kind: Parameters<AgentMetricsPort["recordRetry"]>[0]): void {
    if (!this.metrics) return;
    try {
      this.metrics.recordRetry(kind);
    } catch (err) {
      this.logger.warn('metrics recordRetry failed (non-fatal)', {
        kind, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * F20260814mtrc：记录一次 attempt 的 metrics。
   * otter_type/model/source 在此汇聚；metrics 失败绝不影响主流程。
   * 同一 attempt（messageId+retryCount）只记一次。
   */
  private async recordAttempt(p: {
    messageId: string;
    otterId: string;
    result?: InvokeResultShape;
    err?: unknown;
    outcome: InvokeOutcome;
    retryCount: number;
    manualRetry: boolean;
    startTime: number;
  }): Promise<void> {
    if (!this.metrics) return;
    const key = this.attemptKey(p.messageId, p.retryCount);
    if (this.recordedAttempts.has(key)) return;
    this.recordedAttempts.add(key);
    try {
      const otter = await this.queryOtter.getById(p.otterId);
      const record = this.buildInvokeRecord(p, otter?.type);
      if (p.result?.sessionRebuilt) this.metrics.recordSessionRebuild();
      this.metrics.recordInvoke(record);
    } catch (err) {
      this.logger.warn('metrics recording failed (non-fatal)', {
        otterId: p.otterId, outcome: p.outcome,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** err 路径的模型别名回退（pi-session-factory catch 分支透传，PR 审视 P1 修复） */
  private resolveModel(result: InvokeResultShape | undefined, err: unknown): string {
    return result?.modelAlias ?? (err as ErrorWithToolCallCount | undefined)?._modelAlias ?? "unknown";
  }

  /** 组装 attempt 记录（otter_type/model 缺失记 unknown；err 路径 model 从 error 附带字段回退） */
  private buildInvokeRecord(
    p: { otterId: string; result?: InvokeResultShape; err?: unknown; outcome: InvokeOutcome; retryCount: number; manualRetry: boolean; startTime: number },
    otterType?: string,
  ): InvokeOutcomeRecord {
    const errMeta = p.err as ErrorWithToolCallCount | undefined;
    return {
      otterId: p.otterId,
      model: this.resolveModel(p.result, p.err),
      otterType: otterType ?? "unknown",
      source: getTraceContext().source ?? "direct",
      outcome: p.outcome,
      retry: toRetryLabel(p.retryCount, p.manualRetry),
      durationMs: Date.now() - p.startTime,
      tokenUsage: p.result?.tokenUsage,
      ctxTokens: p.result?.ctxTokens,
      firstByteLatencyMs: p.result?.outputGuardMetadata?.firstByteLatencyMs
        ?? errMeta?._outputGuardMetadata?.firstByteLatencyMs,
    };
  }

  /**
   * F20260814mtrc：失败 attempt 记录（分类后、路由前；duration 不含重试链）。
   * 同步方法：去重键/guard 计数/重试意图同步完成（防重入双计），DB 读 fire-and-forget
   * （不阻塞路由——对齐成功路径，PR 四审修复）。
   */
  private recordFailedAttempt(reason: ExitReason, p: {
    messageId: string; otterId: string; result?: InvokeResultShape; err?: unknown;
    retryCount: number; manualRetry: boolean; attemptStartTime: number;
  }): void {
    if (!this.metrics) return;
    if (this.recordedAttempts.has(this.attemptKey(p.messageId, p.retryCount))) return;
    if (reason.kind === 'guard_abort') {
      /** PR 审视修复：安全壳 + err 路径 model 回退 */
      try {
        this.metrics.recordGuardAbort(this.resolveModel(p.result, p.err), reason.guardReason);
      } catch (err) {
        this.logger.warn('metrics recordGuardAbort failed (non-fatal)', {
          reason: reason.guardReason, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    /** PR 四审 P1 修复：重试意图计数移到分类点（受去重键保护）——散落在路由方法里的
     * 计数在"路由抛错 → 重入"场景会双计（与第三轮 P0 同源场景） */
    this.recordRetryIntent(reason, p.retryCount);
    void this.recordAttempt({
      messageId: p.messageId, otterId: p.otterId, result: p.result, err: p.err,
      outcome: this.exitKindToOutcome(reason.kind, p.retryCount),
      retryCount: p.retryCount, manualRetry: p.manualRetry,
      startTime: p.attemptStartTime,
    });
  }

  /**
   * 重试意图计数（与退出分类同点、同一去重键）。
   * 语义为"意图"：个别降级路径（sendSystem 失败转 abort 等）计入但二次 invoke 未发生。
   * 条件镜像 routeGuardAbort/handleSpeakRetry 的重试触发条件（retryCount===0）。
   */
  private recordRetryIntent(reason: ExitReason, retryCount: number): void {
    if (retryCount !== 0) return;
    if (reason.kind === 'no_speak') {
      this.recordRetrySafe("no_speak");
      return;
    }
    if (reason.kind !== 'guard_abort') return;
    if (reason.guardReason === 'degenerate_output') {
      this.recordRetrySafe("degenerate_output");
      return;
    }
    if (this.isRetryableGuardAbort(reason.guardReason)) {
      this.recordRetrySafe(reason.guardReason.startsWith("circuit_break:")
        ? "circuit_break"
        : reason.guardReason as "streaming_timeout" | "first_byte_timeout");
    }
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

  /** 注入对话工作区路径到 DynamicContext */
  private async injectWorkspacePath(ctx: DynamicContext, conversationId: string): Promise<void> {
    if (!this.workspaceGateway) return;
    const ok = await this.workspaceGateway.exists(conversationId);
    if (ok) {
      ctx.workspacePath = this.workspaceGateway.getWorkspacePath(conversationId);
    }
  }
}
