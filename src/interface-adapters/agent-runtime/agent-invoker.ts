import type { AgentInvokePort, AgentStreamEvent, DynamicContext } from "./agent-invoke-port";
import type { SendMessage, MessageEventInput } from "@usecases/conversation/send-message";
import type { SearchMemory } from "@usecases/memory/search-memory";
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
      return { event: "turn.complete", data: {} };
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
    private readonly searchMemory: SearchMemory,
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

    const dynamicContext = await this.buildDynamicContext(otterId, userMessageContent);

    const message = await this.sendMessage.start({
      conversationId,
      senderId: otterId,
      talkingStonePassedTo: [senderId],
    });

    onSSEEvent?.({ event: "message.start", data: { messageId: message.id, otterId } });

    try {
      const result = await this.agentInvoke.invoke(otterId, userMessageContent, {
        dynamicContext,
        onEvent: (e: AgentStreamEvent) => {
          const sse = mapToSSEEvent(e);
          if (sse) onSSEEvent?.(sse);
          const evt = mapToMessageEventInput(e, message.id);
          if (evt) this.sendMessage.appendEvent(evt).catch(() => {});
        },
      });

      await this.sendMessage.complete(message.id, {
        body: result.text,
        talkingStonePassedTo: [senderId],
      });

      const duration = Date.now() - startTime;
      onSSEEvent?.({
        event: "message.complete",
        data: { messageId: message.id, duration: `${(duration / 1000).toFixed(1)}s` },
      });

      return { messageId: message.id, duration, tokenUsage: result.tokenUsage };
    } catch (err) {
      await this.sendMessage.fail(message.id);
      if (this.abortedOtters.delete(otterId)) {
        onSSEEvent?.({ event: "message.aborted", data: { messageId: message.id } });
      } else {
        const msg = err instanceof Error ? err.message : "Unknown error";
        onSSEEvent?.({ event: "error", data: { message: msg } });
      }
      throw err;
    }
  }

  /** 中断 Agent 生成（UA-2: 调用 PiHarnessFactory.abort()） */
  abort(otterId: string, _messageId: string): void {
    this.abortedOtters.add(otterId);
    this.agentInvoke.abort(otterId);
  }

  /** 构建 DynamicContext：记忆检索 + 会话摘要（KDR-9） */
  private async buildDynamicContext(
    otterId: string,
    userMessage: string,
  ): Promise<DynamicContext> {
    const ctx: DynamicContext = {};

    try {
      const result = await this.searchMemory.search({
        query: userMessage,
        limit: 10,
        layer: "working",
      });
      if (result.entries.length > 0) {
        ctx.memoryRetrieval = result.entries
          .map((e) => `${e.content} (score: ${e.score.toFixed(3)})`)
          .join("\n");
      }
    } catch {
      /** 检索失败时降级为无记忆上下文 */
    }

    try {
      const session = await this.manageSession.getActiveSession(otterId);
      if (session?.summary) {
        ctx.sessionSummary = session.summary;
      }
    } catch {
      /** session 查询失败时降级 */
    }

    return ctx;
  }
}
