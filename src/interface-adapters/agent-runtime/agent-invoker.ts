import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";

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
}

/** Pi 事件 -> SSE 事件映射 */
function mapToSSEEvent(e: AgentStreamEvent): AgentSSEEvent | null {
  switch (e.type) {
    case "message_update":
      return e.delta ? { event: "message.delta", data: { text: e.delta } } : null;
    case "tool_execution_start":
      return { event: "tool.start", data: { toolName: e.name ?? e.toolName ?? "" } };
    case "tool_execution_end":
      return { event: "tool.result", data: { toolName: e.name ?? e.toolName ?? "", result: e.result } };
    case "turn_end":
      /** D5-fix: turn.complete 延迟到 message.complete 之后发出，匹配设计文档事件顺序 */
      return null;
    case "agent_end":
      return { event: "agent.idle", data: {} };
    default:
      return null;
  }
}

/** Pi 事件 -> MessageEventInput 映射（持久化到 DB） */
function mapToMessageEventInput(
  e: AgentStreamEvent,
  messageId: string,
): MessageEventInput | null {
  switch (e.type) {
    case "message_update":
      return e.delta
        ? { messageId, eventType: "text_delta", payload: { text: e.delta } }
        : null;
    case "tool_execution_start":
      return { messageId, eventType: "tool_call", payload: { name: e.name ?? e.toolName } };
    case "tool_execution_end":
      return { messageId, eventType: "tool_result", payload: { name: e.name ?? e.toolName, result: e.result } };
    default:
      if (String(e.type).includes("error")) {
        return { messageId, eventType: "error", payload: { message: String(e.error ?? e.message ?? "Unknown error") } };
      }
      return null;
  }
}

export class AgentInvoker {
  private readonly abortedOtters = new Set<string>();

  constructor(
    private readonly agentInvoke: AgentInvokePort,
    private readonly sendMessage: SendMessage,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
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
  }): Promise<ConversationInvokeResult> {
    const { otterId, conversationId, userMessageContent, senderId, onSSEEvent } = params;
    const startTime = Date.now();

    const dynamicContext = await this.buildDynamicContext(otterId);

    const message = await this.sendMessage.start({
      conversationId,
      senderId: otterId,
      talkingStonePassedTo: [senderId],
    });

    onSSEEvent?.({ event: "message.start", data: { messageId: message.id, otterId } });

    try {
      const result = await this.agentInvoke.invoke(otterId, userMessageContent, {
        dynamicContext,
        conversationId,
        onEvent: (e: AgentStreamEvent) => {
          const sse = mapToSSEEvent(e);
          if (sse) onSSEEvent?.(sse);
          const evt = mapToMessageEventInput(e, message.id);
          if (evt) this.sendMessage.appendEvent(evt).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console -- interface-adapters 不能依赖 frameworks/logger
            console.warn(`Failed to persist message event for ${message.id}: ${m}`);
          });
        },
      });

      const contextTokens = result.tokenUsage
        ? result.tokenUsage.input + result.tokenUsage.output
        : undefined;

      await this.sendMessage.complete(message.id, {
        body: result.text,
        talkingStonePassedTo: [senderId],
        contextTokens,
        contextTokensMax: result.ctxMax,
      });

      /** D2-fix: 清理 stale abort 标记（竞态：abort 被调用但 invoke 成功完成） */
      this.abortedOtters.delete(otterId);

      const duration = Date.now() - startTime;
      onSSEEvent?.({
        event: "message.complete",
        data: {
          messageId: message.id,
          duration: `${(duration / 1000).toFixed(1)}s`,
          ...(contextTokens !== undefined && { ctx: contextTokens }),
          ...(result.ctxMax !== undefined && { ctxMax: result.ctxMax }),
        },
      });

      /** D5-fix: turn.complete 在 message.complete 之后发出（设计文档事件顺序） */
      onSSEEvent?.({ event: "turn.complete", data: {} });

      return { messageId: message.id, duration, tokenUsage: result.tokenUsage };
    } catch (err) {
      await this.handleInvokeError(message.id, otterId, err, onSSEEvent, senderId);
      throw err;
    }
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
    if (this.abortedOtters.delete(otterId)) {
      /** abort 路径：构造合成 body，调用 sendMessage.abort() */
      const toolCallCount =
        (err as Error & { _toolCallCount?: number })._toolCallCount ??
        this.agentInvoke.getToolCallCount(otterId);
      const body = `[用户中断] 经过 ${toolCallCount} 次工具调用后，用户强制中断了当前发言。`;
      try {
        await this.sendMessage.abort(messageId, {
          body,
          talkingStonePassedTo: senderId ? [senderId] : [],
        });
      } catch {
        /** abort() 出错时不覆盖原始错误 */
      }
      onSSEEvent?.({ event: "message.aborted", data: { messageId, abortBody: body } });
    } else {
      /** error 路径：标记失败 */
      try {
        await this.sendMessage.fail(messageId);
      } catch {
        /** fail() 出错时不覆盖原始错误 */
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      onSSEEvent?.({ event: "error", data: { message: msg } });
    }
  }

  /** 中断 Agent 生成（UA-2: 调用 AgentInvokePort.abort()） */
  abort(otterId: string, _messageId: string): void {
    this.abortedOtters.add(otterId);
    this.agentInvoke.abort(otterId);
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
      // eslint-disable-next-line no-console -- interface-adapters 不能依赖 frameworks/logger
      console.warn(`Session lookup failed for otter ${otterId}, degrading to no-session context:`, err);
    }

    return ctx;
  }
}
