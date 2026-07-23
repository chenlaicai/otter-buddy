import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";

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
  private readonly abortedOtters = new Set<string>();

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
    onSSEEvent?.({ event: "message.start", data: { messageId: message.id, otterId, otterName: otter?.name ?? otterId } });

    try {
      const { result } = await this.executeAgentInvocation({
        otterId,
        userMessageContent,
        dynamicContext,
        conversationId,
        messageId: message.id,
        onSSEEvent,
      });

      /** agent loop 已结束，检查消息状态 */
      const msg = await this.queryMessage.getMessageById(message.id);
      this.logger.info('Agent invocation finished', { messageId: message.id, otterId, messageStatus: msg?.status, tokenUsage: result.tokenUsage });

      if (msg?.status === "speaking") {
        /** 正常路径：agent 调用了 speak（状态为 speaking），现在真正完成消息 */
        const completeResult = await this.sendMessage.complete(message.id);
        return await this.completeAgentInvocation({
          otterId,
          conversationId,
          messageId: message.id,
          senderId,
          result,
          startTime,
          onSSEEvent,
          aggregatedTargets: completeResult.turnClose.aggregatedTargets,
        });
      }

      /** agent 未调 speak → 重试机制 */
      return await this.handleSpeakRetry({
        messageId: message.id, otterId, conversationId, userMessageContent,
        senderId, onSSEEvent, retryCount, startTime, tokenUsage: result.tokenUsage,
      });
    } catch (err) {
      await this.handleInvokeError(message.id, otterId, err, onSSEEvent, senderId);
      /** 不 re-throw：错误已通过 SSE 通知前端，controller 用 Promise.allSettled 跟踪完成 */
      return { messageId: message.id, duration: Date.now() - startTime };
    }
  }

  /**
   * 执行 Agent 调用。
   * 返回 result 和 speakBodyReceived 标志（两阶段提交 Phase 1 是否完成）。
   */
  private async executeAgentInvocation(params: {
    otterId: string;
    userMessageContent: string;
    dynamicContext: DynamicContext;
    conversationId: string;
    messageId: string;
    onSSEEvent?: (event: AgentSSEEvent) => void;
  }): Promise<{ result: { text: string; tokenUsage?: { input: number; output: number }; ctxMax?: number }; speakBodyReceived: boolean; aborted: boolean }> {
    let agentError: string | undefined;
    let speakBodyReceived = false;
    try {
      const result = await this.agentInvoke.invoke(params.otterId, params.userMessageContent, {
        dynamicContext: params.dynamicContext,
        conversationId: params.conversationId,
        messageId: params.messageId,
        onEvent: (e: AgentStreamEvent) => {
          this.logger.debug('Agent event received', { messageId: params.messageId, eventType: e.type, toolName: e.name ?? e.toolName });
          /** 所有事件如实推送到 SSE（event 就是 event，不抑制） */
          const sse = mapToSSEEvent(e);
          if (sse) {
            params.onSSEEvent?.({ event: sse.event, data: { ...sse.data, messageId: params.messageId } });
          }
          if (e.type === "tool_execution_end" && (e.name ?? e.toolName) === "speak") {
            speakBodyReceived = true;
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
      /** invoke 正常返回后检查 abort（SDK 可能不抛错） */
      return { result, speakBodyReceived, aborted: this.abortedOtters.has(params.otterId) };
    } catch (err) {
      /** abort 时向外抛出，让 invokeConversation 的外层 catch 处理（不走 retry） */
      if (this.abortedOtters.has(params.otterId)) {
        throw err;
      }
      /** 非 abort 错误：返回结果让外层判断是否 retry */
      return { result: { text: '' }, speakBodyReceived, aborted: false };
    }
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
    this.abortedOtters.delete(otterId);

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
    this.logger.warn('Agent invocation error', { messageId, otterId, error: errMsg, isAbort: this.abortedOtters.has(otterId) });
    if (this.abortedOtters.delete(otterId)) {
      /** abort 路径：构造合成 body，调用 sendMessage.abort() */
      const toolCallCount =
        (err as Error & { _toolCallCount?: number })._toolCallCount ??
        this.agentInvoke.getToolCallCount(otterId, messageId);
      const body = `[用户中断] 经过 ${toolCallCount} 次工具调用后，用户强制中断了当前发言。`;
      try {
        await this.sendMessage.abort(messageId, {
          body,
          talkingStonePassedTo: senderId ? [senderId] : [],
        });
      } catch {
        /** abort() 出错时不覆盖原始错误 */
      }
      onSSEEvent?.({ event: "message.aborted", data: { messageId } });
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
  }): Promise<ConversationInvokeResult> {
    const { messageId, otterId, conversationId, senderId, onSSEEvent, retryCount, startTime, tokenUsage } = params;
    this.logger.info('Speak retry triggered', { messageId, otterId, retryCount });

    if (retryCount === 0) {
      /** 第一次：fail + 系统提醒 + 重试 */
      const failBody = "[系统] 未调用 speak 工具结束发言";
      try { await this.sendMessage.fail(messageId, failBody); } catch { /* ignore */ }

      /** 通知前端当前消息失败，清除 streaming 状态 */
      onSSEEvent?.({ event: "message.failed", data: { messageId, body: failBody } });

      const sysMsg = await this.sendMessage.sendSystem(conversationId, "你必须使用 speak 工具来结束你的发言。请重新组织答复并调用 speak。");

      /** 通知前端系统消息已创建 */
      onSSEEvent?.({ event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body } });

      /** 重试：将系统提醒作为 userMessageContent，session 已有历史上下文 */
      const retryResult = await this.invokeConversation({
        otterId, conversationId,
        userMessageContent: "[系统提醒] 你上一次发言没有调用 speak 工具就结束了，这是错误的。你必须使用 speak 工具来结束你的发言。请重新组织答复并调用 speak。",
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

  /** 中断 Agent 生成（UA-2: 调用 AgentInvokePort.abort()） */
  abort(otterId: string, messageId: string): void {
    this.abortedOtters.add(otterId);
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
