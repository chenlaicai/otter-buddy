import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";

/** 携带工具调用计数的 Error（abort 路径跨层传递用） */
type ErrorWithToolCallCount = Error & { _toolCallCount?: number };

/** SSE 事件（与 sse-streamer 的 SSEEvent 结构兼容） */
export interface AgentSSEEvent {
  event: string;
  data: Record<string, unknown>;
}

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

function mapToSSEEvent(e: AgentStreamEvent): AgentSSEEvent | null {
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

/** 从 agent 事件中提取错误信息 */
function extractAgentError(e: AgentStreamEvent): string | undefined {
  if (e.type === "error") return String(e.error ?? e.message ?? "Unknown agent error");
  if (e.type === "tool_execution_end" && e.error) return String(e.error);
  if (e.type === "turn_end") return extractTurnEndError(e);
  return undefined;
}

function extractTurnEndError(e: AgentStreamEvent): string | undefined {
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = (inner ?? (e as Record<string, unknown>).message) as Record<string, unknown> | undefined;
  if (msg?.stopReason === "error" || msg?.errorMessage) {
    return String(msg.errorMessage ?? "Agent API error");
  }
  return undefined;
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
  ) {}

  /**
   * 驱动 Agent 对话：构建上下文 -> 创建 streaming 消息 -> invoke -> 事件映射 -> 完成/失败。
   * B7-B11 行为实现。
   */
  async invokeConversation(params: {
    otterId: string;
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    onSSEEvent?: (event: AgentSSEEvent) => void;
    retryCount?: number;
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, userMessageContent, senderId, onSSEEvent, retryCount = 0 } = params;
    const startTime = Date.now();

    // 记录 Agent 调用开始日志
    this.logger.info('Agent invocation started', {
      otterId,
      conversationId,
      messageLength: userMessageContent.length,
    });

    const dynamicContext = await this.buildDynamicContext(otterId);

    const message = await this.sendMessage.start({
      conversationId,
      senderId: otterId,
      talkingStonePassedTo: [senderId],
    });

    const otter = await this.queryOtter.getById(otterId);
    /** seq 带给前端：进行中消息按服务端 sequence 插入消息流（M5：保证跨 otter 时序正确） */
    onSSEEvent?.({ event: "message.start", data: { messageId: message.id, otterId, otterName: otter?.name ?? otterId, seq: message.sequenceNum, createdAt: message.createdAt } });

    try {
      const { result, toolCallCount } = await this.executeAgentInvocation({
        otterId, userMessageContent, dynamicContext, conversationId, messageId: message.id, onSSEEvent,
      });
      return await this._handlePostInvocation({
        messageId: message.id, otterId, senderId, result, toolCallCount, startTime, onSSEEvent, retryCount, userMessageContent, conversationId,
      });
    } catch (err) {
      const finalErr = this.wrapInternalAbort(message.id, err);
      await this.handleInvokeError(message.id, otterId, finalErr, onSSEEvent, senderId);
      return { messageId: message.id, duration: Date.now() - startTime };
    }
  }

  /** invoke 后处理：检查 speaking/abort/retry 状态 */
  private async _handlePostInvocation(p: {
    messageId: string; otterId: string; senderId: string;
    result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number };
    toolCallCount: number; startTime: number;
    onSSEEvent?: (event: AgentSSEEvent) => void; retryCount?: number;
    userMessageContent?: string; conversationId?: string;
  }): Promise<ConversationInvokeResult> {
    const msg = await this.queryMessage.getMessageById(p.messageId);
    this.logger.info('Agent invocation finished', { messageId: p.messageId, otterId: p.otterId, messageStatus: msg?.status, tokenUsage: p.result.tokenUsage });
    if (msg?.status === "speaking") {
      const cr = await this.sendMessage.complete(p.messageId);
      return this.completeAgentInvocation({ otterId: p.otterId, conversationId: p.conversationId ?? "", messageId: p.messageId, senderId: p.senderId, result: p.result, startTime: p.startTime, onSSEEvent: p.onSSEEvent, aggregatedTargets: cr.turnClose.aggregatedTargets });
    }
    if (this.abortedMessages.has(p.messageId)) {
      await this.handleInvokeError(p.messageId, p.otterId, Object.assign(new Error("Invocation aborted by user"), { _toolCallCount: p.toolCallCount }), p.onSSEEvent, p.senderId);
      return { messageId: p.messageId, duration: Date.now() - p.startTime };
    }
    const ir = (p.result as Record<string, unknown>)._guardAbortReason as string | undefined ?? this.agentInvoke.getInternalAbortReason(p.messageId);
    if (ir) {
      this.abortedMessages.add(p.messageId);
      const prefix = ir.startsWith("circuit_break:") ? "[circuit-breaker]" : "[output-guard]";
      await this.handleInvokeError(p.messageId, p.otterId, Object.assign(new Error(`${prefix} ${ir}`), { _toolCallCount: p.toolCallCount }), p.onSSEEvent, p.senderId);
      return { messageId: p.messageId, duration: Date.now() - p.startTime };
    }
    return this.handleSpeakRetry({ messageId: p.messageId, otterId: p.otterId, conversationId: p.conversationId ?? "", userMessageContent: p.userMessageContent ?? "", senderId: p.senderId, onSSEEvent: p.onSSEEvent, retryCount: p.retryCount ?? 0, startTime: p.startTime, tokenUsage: p.result.tokenUsage, resultText: p.result.text });
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
    onSSEEvent?: (event: AgentSSEEvent) => void;
  }): Promise<{ result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number }; toolCallCount: number }> {
    let agentError: string | undefined;
    let toolCallCount = 0;
    const result = await this.agentInvoke.invoke(params.otterId, params.userMessageContent, {
      dynamicContext: params.dynamicContext,
      conversationId: params.conversationId,
      messageId: params.messageId,
      onEvent: (e: AgentStreamEvent) => {
        this.logger.debug('Agent event received', { messageId: params.messageId, eventType: e.type, toolName: e.name ?? e.toolName });
        if (e.type === "tool_execution_start") toolCallCount++;
        /** 所有事件如实推送到 SSE（event 就是 event，不抑制） */
        const sse = mapToSSEEvent(e);
        if (sse) {
          params.onSSEEvent?.({ event: sse.event, data: { ...sse.data, messageId: params.messageId } });
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
        if (!agentError) agentError = extractAgentError(e);
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
    onSSEEvent?: (event: AgentSSEEvent) => void;
    aggregatedTargets?: string[];
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, messageId, result, startTime, onSSEEvent, aggregatedTargets } = params;

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
    onSSEEvent?.({
      event: "message.complete",
      data: {
        messageId,
        body: msg?.body ?? '',
        turnId: msg?.turnId ?? '',
        duration: `${(duration / 1000).toFixed(1)}s`,
        ctx: totalTokens,
        ctxMax: result.ctxMax,
      },
    });

    /** D5-fix: turn.complete 在 message.complete 之后发出（设计文档事件顺序） */
    onSSEEvent?.({ event: "turn.complete", data: {} });

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
      return "[系统保护] 输出异常，已自动中断。";
    }
    const toolCallCount = (err as ErrorWithToolCallCount)._toolCallCount ?? this.agentInvoke.getToolCallCount(otterId, messageId);
    return `[搭档中断] 经过 ${toolCallCount} 次工具调用后，搭档强制中断了当前发言。`;
  }

  /**
   * 处理 invoke 异常：区分 abort/error 路径。
   * abort 路径：构造合成 body → sendMessage.abort() → SSE message.aborted
   * error 路径：sendMessage.fail() → SSE error
   */
  private async handleInvokeError(
    messageId: string,
    otterId: string,
    err: unknown,
    onSSEEvent?: (event: AgentSSEEvent) => void,
    senderId?: string,
  ): Promise<void> {
    const errMsg = err instanceof Error ? err.message : String(err);
    this.logger.warn('Agent invocation error', { messageId, otterId, error: errMsg, isAbort: this.abortedMessages.has(messageId) });
    if (this.abortedMessages.delete(messageId)) {
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
      onSSEEvent?.({ event: "message.aborted", data: { messageId, body, otterId, otterName: otter?.name } });
    } else {
      /** error 路径：标记失败，发送 error SSE 事件 */
      const msg = err instanceof Error ? err.message : "Unknown error";
      try {
        await this.sendMessage.fail(messageId, `[错误] ${msg}`);
      } catch {
        /** fail() 出错时不覆盖原始错误 */
      }
      onSSEEvent?.({ event: "error", data: { message: msg, messageId, otterId } });
    }
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
    onSSEEvent?: (event: AgentSSEEvent) => void;
    retryCount: number;
    agentError?: string;
    startTime: number;
    tokenUsage?: { input: number; output: number };
    resultText?: string;
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, conversationId, senderId, onSSEEvent, retryCount, startTime, tokenUsage, resultText } = params;
    this.logger.info('Speak retry triggered', { messageId, otterId, retryCount });

    if (retryCount === 0) {
      /** 第一次：fail + 系统提醒 + 重试 */
      const failBody = "[系统] 未调用 speak 工具结束发言";
      try { await this.sendMessage.fail(messageId, failBody); } catch { /* ignore */ }

      /** 通知前端当前消息失败，清除 streaming 状态 */
      onSSEEvent?.({ event: "message.failed", data: { messageId, body: failBody } });

      /** thinking-only（空响应）vs 有正文但漏了 speak：区分提示。系统消息与重试 prompt 保持一致 */
      const isThinkingOnly = !resultText || resultText.trim().length === 0;
      const retryMsg = isThinkingOnly
        ? "[系统提醒] 你上一轮没有产生正文输出也没有调用工具。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。"
        : "[系统提醒] 你上一次发言没有调用 speak 工具就结束了。请重新组织答复并调用 speak。";

      const sysMsg = await this.sendMessage.sendSystem(conversationId, retryMsg);

      /** 通知前端系统消息已创建 */
      onSSEEvent?.({ event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body } });

      /** 重试：系统消息已入历史，此处作为 userMessageContent 再次传入确保 LLM 注意到 */
      const retryResult = await this.invokeConversation({
        otterId, conversationId,
        userMessageContent: retryMsg,
        senderId, onSSEEvent, retryCount: 1,
      });
      /** 合并重试的 tokenUsage（重试路径可能已更新） */
      return { ...retryResult, tokenUsage: retryResult.tokenUsage ?? tokenUsage };
    }

    /** 第二次仍失败：fail + 发言石额外包含 user */
    const failBody = "[系统] 重试后仍未调用 speak 工具";
    try {
      await this.sendMessage.fail(messageId, failBody, [senderId]);
    } catch { /* ignore */ }

    const duration = Date.now() - startTime;
    /** msg2 终结：发送 message.failed（不是 complete），关闭消息生命周期 */
    onSSEEvent?.({ event: "message.failed", data: { messageId, body: failBody } });

    return { messageId, duration, tokenUsage };
  }

  /** 中断 Agent 生成（UA-2: 调用 AgentInvokePort.abort()）；标记按 messageId 键控 */
  abort(otterId: string, messageId: string): void {
    this.abortedMessages.add(messageId);
    this.agentInvoke.abort(otterId, messageId);
  }

  /** 构建 DynamicContext：会话摘要 + 交接摘要（B-CS-3）。记忆召回由 agent 通过 search_memory tool 主动触发 */
  private async buildDynamicContext(
    otterId: string,
  ): Promise<DynamicContext> {
    const ctx: DynamicContext = {};

    try {
      const session = await this.manageSession.getActiveSession(otterId);
      if (session?.handoffSummary) {
        /** B-CS-3: 交接摘要优先于普通 summary（信息密度更高） */
        ctx.sessionSummary = [
          `[Session #${session.handoffSummary.sessionSequence} 交接摘要]`,
          `关键决策: ${session.handoffSummary.keyDecisions.join("; ") || "无"}`,
          `待完成任务: ${session.handoffSummary.pendingTasks.join("; ") || "无"}`,
          `当前上下文: ${session.handoffSummary.activeContext}`,
        ].join("\n");
      } else if (session?.summary) {
        ctx.sessionSummary = session.summary;
      }
    } catch (err) {
      this.logger.warn(`Session lookup failed for otter ${otterId}, degrading to no-session context:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return ctx;
  }
}
