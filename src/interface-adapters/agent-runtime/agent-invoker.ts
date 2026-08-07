/* eslint-disable max-lines */
import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { SSEEvent } from "@contract/sse/events";

/** 携带工具调用计数的 Error（abort 路径跨层传递用） */
type ErrorWithToolCallCount = Error & { _toolCallCount?: number };

/** Agent 对话调用结果 */
export interface ConversationInvokeResult {
  messageId: string;
  duration: number;
  tokenUsage?: { input: number; output: number };
  /** Turn 关闭后的聚合发言石目标 */
  aggregatedTargets?: string[];
}

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

function mapToSSEEvent(e: AgentStreamEvent): SSEEvent | null {
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
  /** abort 标记按 messageId 键控（同一 otter 可并发多个 invoke，按 otterId 键控会跨消息串扰） */
  private readonly abortedMessages = new Set<string>();

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
  ) {}

  /**
   * 驱动 Agent 对话：构建上下文 -> 创建 streaming 消息 -> invoke -> 事件映射 -> 完成/失败。
   * B7-B11 行为实现。
   *
   * streaming 事件通过 messageBroadcaster.broadcastEvent 统一推送给所有订阅者。
   * onSSEEvent 可选覆盖（测试用），默认走 broadcastEvent。
   */
  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
  }): Promise<ConversationInvokeResult> {
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

    try {
      const { result, toolCallCount } = await this.executeAgentInvocation({
        otterId, userMessageContent, dynamicContext, conversationId, messageId: message.id, emitEvent,
      });
      return await this._handlePostInvocation({
        messageId: message.id, otterId, senderId, result, toolCallCount, startTime, emitEvent, onSSEEvent, retryCount, userMessageContent, conversationId,
      });
    } catch (err) {
      /** F146 修复：degenerate_output 梯度介入在 catch 路径中拦截，
       *  走 handleDegenerateRetry 重试而非直接 abort 终态。
       *  wrapInternalAbort 会消费 guardAbortReason 并加入 abortedMessages，
       *  故必须在调用前判断。 */
      const abortReason = (err as { _guardAbortReason?: string })._guardAbortReason
        ?? this.agentInvoke.getInternalAbortReason(message.id);
      if (abortReason === "degenerate_output" && retryCount === 0) {
        this.logger.info('Degenerate output detected in catch path, attempting retry', { messageId: message.id, otterId });
        return this.handleDegenerateRetry({
          messageId: message.id, otterId, senderId,
          result: { text: "", tokenUsage: undefined },
          toolCallCount: (err as ErrorWithToolCallCount)._toolCallCount ?? 0,
          startTime, emitEvent, onSSEEvent,
          retryCount: 0, userMessageContent, conversationId,
        });
      }
      const finalErr = this.wrapInternalAbort(message.id, err);
      await this.handleInvokeError({ messageId: message.id, otterId, err: finalErr, emitEvent, senderId, conversationId, startTime, userMessageContent, onSSEEvent, retryCount });
      return { messageId: message.id, duration: Date.now() - startTime };
    }
  }

  /** invoke 后处理：检查 speaking/abort/retry 状态 */
  private async _handlePostInvocation(p: {
    messageId: string; otterId: string; senderId: string;
    result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number };
    toolCallCount: number; startTime: number;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const msg = await this.queryMessage.getMessageById(p.messageId);
    this.logger.info('Agent invocation finished', { messageId: p.messageId, otterId: p.otterId, messageStatus: msg?.status, tokenUsage: p.result.tokenUsage });
    if (msg?.status === "speaking") {
      /** token 用量随 complete 落库（口径与 SSE 实时事件一致：input+output），刷新后历史消息仍能展示上下文使用率 */
      const totalTokens = p.result.tokenUsage ? p.result.tokenUsage.input + p.result.tokenUsage.output : undefined;
      const cr = await this.sendMessage.complete(p.messageId, {
        contextTokens: totalTokens,
        contextTokensMax: p.result.ctxMax,
      });
      return this.completeAgentInvocation({ otterId: p.otterId, conversationId: p.conversationId ?? "", messageId: p.messageId, senderId: p.senderId, result: p.result, startTime: p.startTime, emitEvent: p.emitEvent, aggregatedTargets: cr.turnClose.aggregatedTargets });
    }
    if (this.abortedMessages.has(p.messageId)) {
      await this.handleInvokeError({ messageId: p.messageId, otterId: p.otterId, err: Object.assign(new Error("Invocation aborted by user"), { _toolCallCount: p.toolCallCount }), emitEvent: p.emitEvent, senderId: p.senderId, conversationId: p.conversationId, startTime: p.startTime });
      return { messageId: p.messageId, duration: Date.now() - p.startTime };
    }
    return this._handleGuardAbortOrSpeakRetry(p);
  }

  /** guard abort / 重试判断：提取以降低 _handlePostInvocation 圈复杂度 */
  private async _handleGuardAbortOrSpeakRetry(p: {
    messageId: string; otterId: string; senderId: string;
    result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number };
    toolCallCount: number; startTime: number;
    emitEvent: (event: SSEEvent) => void;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const ir = (p.result as Record<string, unknown>)._guardAbortReason as string | undefined ?? this.agentInvoke.getInternalAbortReason(p.messageId);
    if (ir) {
      /** F146: degenerate_output 梯度介入：重试一次，再犯才落终态 */
      if (ir === "degenerate_output" && (p.retryCount ?? 0) === 0) {
        return this.handleDegenerateRetry(p);
      }
      this.abortedMessages.add(p.messageId);
      const prefix = ir.startsWith("circuit_break:") ? "[circuit-breaker]" : "[output-guard]";
      await this.handleInvokeError({ messageId: p.messageId, otterId: p.otterId, err: Object.assign(new Error(`${prefix} ${ir}`), { _toolCallCount: p.toolCallCount }), emitEvent: p.emitEvent, senderId: p.senderId, conversationId: p.conversationId, startTime: p.startTime, userMessageContent: p.userMessageContent, onSSEEvent: p.onSSEEvent, retryCount: p.retryCount });
      return { messageId: p.messageId, duration: Date.now() - p.startTime };
    }
    return this.handleSpeakRetry({ messageId: p.messageId, otterId: p.otterId, conversationId: p.conversationId ?? "", userMessageContent: p.userMessageContent ?? "", senderId: p.senderId, emitEvent: p.emitEvent, onSSEEvent: p.onSSEEvent, retryCount: p.retryCount ?? 0, startTime: p.startTime, tokenUsage: p.result.tokenUsage, toolCallCount: p.toolCallCount });
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
  }): Promise<{ result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number }; toolCallCount: number }> {
    let toolCallCount = 0;
    this.logger.debug('Calling agentInvoke.invoke', { otterId: params.otterId, messageId: params.messageId });
    const result = await this.agentInvoke.invoke(params.otterId, params.userMessageContent, {
      dynamicContext: params.dynamicContext,
      conversationId: params.conversationId,
      messageId: params.messageId,
      onEvent: (e: AgentStreamEvent) => {
        this.logger.debug('Agent event received', { messageId: params.messageId, eventType: e.type, toolName: e.name ?? e.toolName });
        if (e.type === "tool_execution_start") toolCallCount++;
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
    result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number };
    startTime: number;
    emitEvent: (event: SSEEvent) => void;
    aggregatedTargets?: string[];
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, messageId, result, startTime, emitEvent, aggregatedTargets } = params;

    /** 消息已在 invokeConversation 中通过 sendMessage.complete() 完成，此处发 SSE 事件和清理状态 */

    /** D2-fix: 清理 stale abort 标记（竞态：abort 被调用但 invoke 成功完成） */
    this.abortedMessages.delete(messageId);

    const duration = Date.now() - startTime;

    // 记录 Agent 调用完成日志
    this.logger.info('Agent invocation completed', {
      otterId,
      conversationId,
      messageId,
      duration,
      tokenUsage: result.tokenUsage,
      status: 'success',
    });

    const totalTokens = result.tokenUsage ? result.tokenUsage.input + result.tokenUsage.output : undefined;
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
        ctx: totalTokens,
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

  /**
   * 内部 abort 包装：检查是否有 OutputGuard 等内部机制触发的 abort。
   * 优先从 error 对象读取 _guardAbortReason（finally 前预捕获），
   * 回退到 getInternalAbortReason（activeSessions 查找）。
   * 竞态防护：用户已 abort 时不覆盖（High-1）。
   */
  private wrapInternalAbort(messageId: string, err: unknown): unknown {
    if (this.abortedMessages.has(messageId)) return err;
    const reason = (err as { _guardAbortReason?: string })._guardAbortReason ?? this.agentInvoke.getInternalAbortReason(messageId);
    if (!reason) return err;
    this.abortedMessages.add(messageId);
    /** 按归因打前缀：熔断器 abort 不再伪装成 OutputGuard */
    const prefix = reason.startsWith("circuit_break:") ? "[circuit-breaker]" : "[output-guard]";
    return Object.assign(new Error(`${prefix} ${reason}`), {
      _toolCallCount: (err as ErrorWithToolCallCount)._toolCallCount ?? 0,
    });
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

  /** 自动重试拦截：判断是否可重试并执行，返回 true 表示已处理 */
  private async _tryAutoRetry(p: {
    messageId: string; otterId: string; err: unknown;
    emitEvent: (event: SSEEvent) => void; senderId?: string;
    conversationId?: string; startTime?: number;
    userMessageContent?: string; autoRetryCount?: number;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
  }): Promise<boolean> {
    const autoRetryCount = p.autoRetryCount ?? 0;
    const retryCount = p.retryCount ?? 0;
    if (autoRetryCount !== 0 || retryCount > 0 || !p.conversationId || !p.userMessageContent) return false;

    const abortReason = this._extractAbortReason(p.messageId, p.err);

    // abort 路径：可重试的 guard abort
    if (abortReason && this._isRetryableAbortReason(abortReason)) {
      this.logger.info('Auto-retry on abort reason', { messageId: p.messageId, otterId: p.otterId, reason: abortReason });
      await this._executeAutoRetry(p as Parameters<typeof this._executeAutoRetry>[0], abortReason);
      return true;
    }

    // error 路径：API error
    if (!abortReason && this._isRetryableApiError(p.err)) {
      this.logger.info('Auto-retry on API error', { messageId: p.messageId, otterId: p.otterId });
      await this._executeAutoRetry(p as Parameters<typeof this._executeAutoRetry>[0], 'api_error');
      return true;
    }

    return false;
  }

  /** 从 error 中提取 abort reason（不修改 abortedMessages） */
  private _extractAbortReason(messageId: string, err: unknown): string | undefined {
    return (err as { _guardAbortReason?: string })._guardAbortReason
      ?? this.agentInvoke.getInternalAbortReason(messageId);
  }

  /** 判断 abort reason 是否值得自动重试（degenerate_output 已有专门逻辑，不重复） */
  private _isRetryableAbortReason(reason: string): boolean {
    if (reason === "degenerate_output") return false;
    if (reason === "streaming_timeout") return true;
    if (reason === "first_byte_timeout") return true;
    if (reason.startsWith("circuit_break:")) return true;
    return false;
  }

  /** 判断 API error 是否值得自动重试（SDK auto-retry 耗尽后 _checkSessionError 抛出） */
  private _isRetryableApiError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("LLM API error:")) return true;
    return false;
  }

  /** 执行自动重试：不注入系统消息，直接 fail + re-invoke（session 上下文已完整） */
  private async _executeAutoRetry(
    p: { messageId: string; otterId: string; senderId?: string; conversationId: string;
         userMessageContent: string; emitEvent: (e: SSEEvent) => void; onSSEEvent?: (e: SSEEvent) => void;
         startTime?: number; },
    reason: string,
  ): Promise<void> {
    const failBody = `[系统] ${this._buildRetryFailBody(reason)}, 正在自动重试`;

    /** 1. fail 当前消息（前端展示过渡态） */
    try { await this.sendMessage.fail(p.messageId, failBody); } catch { /* ignore */ }
    const otter = await this.queryOtter.getById(p.otterId);
    const otterName = otter?.name ?? p.otterId;
    p.emitEvent({ event: "message.failed", data: { messageId: p.messageId, otterId: p.otterId, otterName, body: failBody } });

    /** 2. 清理 abortedMessages（不走终态 abort 路径，需要手动清理） */
    this.abortedMessages.delete(p.messageId);

    /** 3. 直接 re-invoke，不注入系统消息——session 上下文已完整保留 */
    await this.invokeConversation({
      otterId: p.otterId, conversationId: p.conversationId,
      userMessageContent: p.userMessageContent,
      senderId: p.senderId ?? p.otterId,
      retryCount: 1,
      onSSEEvent: p.onSSEEvent,
    });
  }

  /** 构造自动重试的过渡态消息 */
  private _buildRetryFailBody(reason: string): string {
    if (reason === "streaming_timeout") return "生成过程超时";
    if (reason === "first_byte_timeout") return "模型响应超时";
    if (reason.startsWith("circuit_break:")) return "工具调用异常";
    if (reason === "api_error") return "模型服务异常";
    return "执行异常";
  }

  /** 构造 abort body：区分用户手动中断、内部机制中断（Medium-2 友好消息） */
  private buildAbortBody(err: unknown, otterId: string, messageId: string): string {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.startsWith("[circuit-breaker]")) {
      if (errMsg.includes("event_timeout")) return "[系统保护] 单次工具调用超时，已自动中断。";
      return "[系统保护] 检测到工具调用异常循环，已自动中断。";
    }
    if (errMsg.startsWith("[output-guard]")) {
      if (errMsg.includes("degenerate_output")) return "[系统保护] 检测到输出内容异常重复，已自动中断。";
      if (errMsg.includes("streaming_timeout")) return "[系统保护] 生成过程超时，已自动中断。";
      if (errMsg.includes("first_byte_timeout")) return "[系统保护] 模型响应超时，已自动中断。";
      return "[系统保护] 输出异常，已自动中断。";
    }
    const toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? this.agentInvoke.getToolCallCount(otterId, messageId);
    return `[搭档中断] 经过 ${toolCallCount} 次工具调用后，搭档强制中断了当前发言。`;
  }

  /**
   * 处理 invoke 异常：区分 abort/error 路径。
   * abort 路径：构造合成 body → sendMessage.abort() → SSE message.aborted
   * error 路径：sendMessage.fail() → SSE error
   *
   * F20260806cbsx: 若消息已 speaking（speak 已提交 body），内容交付优先于中断语义——
   * 改走 complete 收尾，不覆盖已交付内容。
   *
   * 自动重试：在到达终态前，拦截可重试异常（timeout、circuit breaker、API error），
   * 自动注入系统提醒并重新触发 agent 执行，用户无需手动干预。
   */
  private async handleInvokeError(p: {
    messageId: string;
    otterId: string;
    err: unknown;
    emitEvent: (event: SSEEvent) => void;
    senderId?: string;
    conversationId?: string;
    startTime?: number;
    userMessageContent?: string;
    autoRetryCount?: number;
    onSSEEvent?: (event: SSEEvent) => void;
    retryCount?: number;
  }): Promise<void> {
    // --- 自动重试拦截（终态之前） ---
    if (await this._tryAutoRetry(p)) return;

    const { messageId, otterId, err, emitEvent, senderId, conversationId, startTime } = p;
    const errMsg = err instanceof Error ? err.message : String(err);
    this.logger.warn('Agent invocation error', { messageId, otterId, error: errMsg, isAbort: this.abortedMessages.has(messageId) });
    if (this.abortedMessages.delete(messageId)) {
      // F20260806cbsx: speaking 守卫——发言已提交时内容交付优先
      const completedIfSpeaking = await this.completeSpeakingMessage(messageId, otterId, emitEvent, senderId, conversationId, startTime);
      if (completedIfSpeaking) return;
      /** abort 路径：构造合成 body，调用 sendMessage.abort() */
      const body = this.buildAbortBody(err, otterId, messageId);
      try {
        await this.sendMessage.abort(messageId, {
          body,
          talkingStonePassedTo: senderId ? [senderId] : [],
        });
      } catch {
        /** abort() 出错时不覆盖原始错误 */
      }
      /** 携带 otter 身份：前端可能在 abort 前已乐观清除 streaming entry，无法本地解析名称 */
      const otter = await this.queryOtter.getById(otterId);
      emitEvent({ event: "message.aborted", data: { messageId, body, otterId, otterName: otter?.name } });
    } else {
      /** error 路径：标记失败，发送 error SSE 事件 */
      const msg = err instanceof Error ? err.message : "Unknown error";
      try {
        await this.sendMessage.fail(messageId, `[错误] ${msg}`);
      } catch {
        /** fail() 出错时不覆盖原始错误 */
      }
      emitEvent({ event: "error", data: { message: msg, messageId, otterId } });
    }
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
      this.abortedMessages.add(messageId);
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
    startTime: number;
    tokenUsage?: { input: number; output: number };
    toolCallCount?: number;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, conversationId, senderId, emitEvent, retryCount, startTime, tokenUsage, toolCallCount } = params;
    this.logger.info('Speak retry triggered', { messageId, otterId, retryCount });
    const otter = await this.queryOtter.getById(otterId);
    const otterName = otter?.name ?? otterId;

    if (retryCount === 0) {
      /** toolCallCount=0 表示 LLM 本轮没有调用任何工具（thinking-only 空响应）；>0 表示有工具调用但漏了 speak */
      const isThinkingOnly = (toolCallCount ?? 0) === 0;
      const retryMsg = isThinkingOnly
        ? "[系统提醒] 你上一轮没有调用任何工具。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。"
        : "[系统提醒] 你上一次发言没有调用 speak 工具就结束了。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。";

      return this.executeRetryWithSystemReminder({
        messageId, otterId, conversationId, senderId, emitEvent,
        onSSEEvent: params.onSSEEvent,
        failBody: "[系统] 未调用 speak 工具结束发言",
        retryMsg,
        tokenUsage,
      });
    }

    /** 第二次仍失败：fail + 发言石额外包含 user */
    this.logger.warn('Speak retry exhausted, failing message', { messageId, otterId, conversationId });
    const failBody = "[系统] 重试后仍未调用 speak 工具";
    try {
      await this.sendMessage.fail(messageId, failBody, [senderId]);
    } catch { /* ignore */ }

    const duration = Date.now() - startTime;
    /** msg2 终结：发送 message.failed（不是 complete），关闭消息生命周期 */
    emitEvent({ event: "message.failed", data: { messageId, otterId, otterName, body: failBody } });

    return { messageId, duration, tokenUsage };
  }

  /** 中断 Agent 生成（UA-2: 调用 AgentInvokePort.abort()）；标记按 messageId 键控 */
  abort(otterId: string, messageId: string): void {
    this.abortedMessages.add(messageId);
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

  /** 注入对话工作区路径到 DynamicContext */
  private async injectWorkspacePath(ctx: DynamicContext, conversationId: string): Promise<void> {
    if (!this.workspaceGateway) return;
    const ok = await this.workspaceGateway.exists(conversationId);
    if (ok) {
      ctx.workspacePath = this.workspaceGateway.getWorkspacePath(conversationId);
    }
  }
}
