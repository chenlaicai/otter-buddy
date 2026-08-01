import type { Context } from "hono";
import { canAbortMessage } from "@entities/conversation/message";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { handleError, param } from "../http-error";
import { toMessageDTO, toMessageEventDTO } from "../dto/message-dto";
import type { SendMessageRequestDTO } from "../dto/message-dto";
import { streamEvents } from "../sse-streamer";

export class MessageController {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定
  constructor(
    private readonly sendMessageUseCase: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly agentInvoker: AgentInvoker,
    private readonly logger: Logger,
    private readonly queryOtter: QueryOtter,
    private readonly dispatchChainEngine: DispatchChainEngine,
    private readonly messageBroadcaster?: MessageBroadcaster,
  ) {}

  /** 批量解析 otter 消息的发送者显示名（dissolve 不删行，永远可解析） */
  private async resolveSenderNames(messages: Array<{ senderType: string; senderId: string }>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const otterSenderIds = [...new Set(messages.filter(m => m.senderType === "otter").map(m => m.senderId))];
    await Promise.all(otterSenderIds.map(async id => {
      const otter = await this.queryOtter.getById(id);
      if (otter) names.set(id, otter.name);
    }));
    return names;
  }

  /** 订阅消息广播（SSE 长连接） */
  async subscribe(c: Context): Promise<Response> {
    const conversationId = param(c, "id");

    if (!this.messageBroadcaster) {
      return c.json({ error: "Message broadcaster not configured" }, 500);
    }

    this.logger.info("[subscribe] SSE subscription request", { conversationId });

    const { response, push, close } = streamEvents(c, undefined, this.logger);

    // 订阅消息广播（消息 + streaming 事件）
    const unsubscribe = this.messageBroadcaster.subscribe(
      conversationId,
      // 消息回调：已完成消息（用户消息、飞书消息等）
      async (message) => {
        this.logger.info("[subscribe] Broadcasting message to SSE", {
          conversationId,
          messageId: message.id,
          senderType: message.senderType,
        });
        // 解析发送者名称（与 list/getById 一致，避免 subscribe 遗漏 sn 导致前端显示 "Otter"）
        let senderName: string | undefined;
        if (message.senderType === "otter") {
          const otter = await this.queryOtter.getById(message.senderId);
          senderName = otter?.name;
        } else if (message.senderType === "user") {
          senderName = "我";
        } else {
          senderName = "系统";
        }
        push({
          event: "message",
          data: toMessageDTO(message, senderName) as unknown as Record<string, unknown>,
        });
      },
      // 事件回调：agent streaming 事件（message.start, assistant_text, message.complete 等）
      (event) => {
        this.logger.info("[subscribe] Forwarding streaming event to SSE", {
          conversationId,
          eventType: event.event,
        });
        push(event);
      },
    );

    // 客户端断连时取消订阅
    c.req.raw.signal.addEventListener("abort", () => {
      this.logger.info("[subscribe] Client abort signal received", { conversationId });
      unsubscribe();
      close();
    });

    return response;
  }

  async list(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const before = c.req.query("before");
      const messages = await this.queryMessage.getMessages(conversationId, {
        limit,
        before,
      });
      /** 批量查询 events（避免前端 N+1 请求） */
      const messageIds = messages.filter((m) => m.senderType === "otter").map((m) => m.id);
      const allEvents = messageIds.length > 0
        ? await this.queryMessage.getMessageEventsByMessageIds(messageIds)
        : [];
      const eventsByMsg = new Map<string, typeof allEvents>();
      for (const evt of allEvents) {
        const arr = eventsByMsg.get(evt.messageId) ?? [];
        arr.push(evt);
        eventsByMsg.set(evt.messageId, arr);
      }
      const senderNames = await this.resolveSenderNames(messages);
      const dtos = messages.map((msg) => {
        const dto = toMessageDTO(msg, senderNames.get(msg.senderId));
        const evts = eventsByMsg.get(msg.id);
        if (evts && evts.length > 0) {
          dto.events = evts.map(toMessageEventDTO);
        }
        return dto;
      });
      return c.json(dtos);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async sendMessage(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<SendMessageRequestDTO>();

      /** 1. 校验请求体（在写入 DB 之前，避免孤儿消息）。
       *  talkingStonePassedTo 允许为空：无 @ 时由 usecase 层按领域规则解析默认目标 */
      if (!body.senderId) {
        return c.json({ error: "senderId is required" }, 400);
      }
      if (!body.body) {
        return c.json({ error: "body is required" }, 400);
      }

      /** 2. 创建用户消息（completed 状态），空目标会被解析为默认派发对象 */
      const userMessage = await this.sendMessageUseCase.send({
        conversationId,
        senderId: body.senderId,
        talkingStonePassedTo: body.talkingStonePassedTo ?? [],
        body: body.body,
      });

      // 广播用户消息到外部渠道（飞书等）
      if (this.messageBroadcaster) {
        this.messageBroadcaster.broadcast(userMessage).catch(err => {
          this.logger.error("Failed to broadcast user message", err instanceof Error ? err : undefined, {
            conversationId,
            messageId: userMessage.id,
          });
        });
      }

      /** 3. 首轮立即派发（以持久化后的消息目标为准，含默认解析结果） */
      const firstTurnTargets = userMessage.talkingStonePassedTo ?? [];

      /** 4. 创建 SSE 流（长连接贯穿多轮）。客户端断开不中止 Agent——发言生命周期由后端状态机管理（UA-刷新续跑） */
      const allTargets = new Set(firstTurnTargets);
      const { response, push, close } = streamEvents(c);

      /** 5. 订阅 broadcaster：统一接收 agent streaming 事件和完成消息 */
      let unsubscribe: (() => void) | undefined;
      if (this.messageBroadcaster) {
        unsubscribe = this.messageBroadcaster.subscribe(
          conversationId,
          // onMessage 为空：POST SSE 流仅接收当前请求触发的 agent 事件（通过 onEvent）。
          // 其他消息（飞书用户消息等）通过 GET SSE 订阅接收，避免重复推送。
          () => {},
          // onEvent：streaming 事件 → 推送到 POST SSE 流
          (event) => {
            push(event);
          },
        );
      }

      /** 6. 启动调度循环（异常时通知前端并收尾，不静默悬挂 SSE） */
      const allTargetsRef = allTargets;
      this.dispatchTurnLoop(firstTurnTargets, { conversationId, userMessageContent: body.body, senderId: body.senderId, allTargets: allTargetsRef })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('发言链调度异常', err instanceof Error ? err : new Error(msg), { conversationId });
          push({ event: "error", data: { message: `发言链调度失败: ${msg}`, messageId: "", otterId: "" } });
        })
        .finally(() => {
          // 清理订阅，防止内存泄漏
          unsubscribe?.();
          // 兜底：如果 subscribe 回调没有关闭流（如无 agent 事件），在此关闭
          setTimeout(() => { push({ event: "stream.end", data: {} }); close(); }, 100);
        });

      return response;
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** Turn 级调度循环：派发一批 otter → 等待全部完成 → 聚合 turn → 派发下一轮 */
  private async dispatchTurnLoop(
    targets: string[],
    ctx: { conversationId: string; userMessageContent: string; senderId: string; allTargets: Set<string> },
  ): Promise<void> {
    const { conversationId, userMessageContent, senderId, allTargets } = ctx;

    // 使用 DispatchChainEngine 执行发言链（事件通过 broadcastEvent 统一推送到订阅者）
    await this.dispatchChainEngine.executeChain({
      conversationId,
      userMessageContent,
      senderId,
      initialTargets: targets,
      invokeFn: async (params) => {
        for (const id of params.otterId ? [params.otterId] : []) allTargets.add(id);
        return this.agentInvoker.invokeConversation({
          otterId: params.otterId,
          conversationId: params.conversationId,
          userMessageContent: params.userMessageContent,
          senderId: params.senderId,
        });
      },
      callbacks: {
        onDepthExceeded: async (pendingTargets, depth) => {
          await this.handleChainDepthExceeded(conversationId, pendingTargets, depth);
        },
      },
    });
  }

  /** 发言链触顶：warn 日志 + 系统消息提示用户接管 */
  private async handleChainDepthExceeded(
    conversationId: string,
    pendingTargets: string[],
    depth: number,
  ): Promise<void> {
    this.logger.warn('发言链达到深度上限，交还用户', { depth, pendingTargets, conversationId });
    const sysMsg = await this.sendMessageUseCase.sendSystem(
      conversationId,
      `发言接力已达系统安全上限（${depth} 跳），发言石交还给你。直接回复即可继续——所有参与者会看到未读消息。`,
    );
    if (this.messageBroadcaster) {
      this.messageBroadcaster.broadcastEvent(conversationId, { event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body } });
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      const senderNames = await this.resolveSenderNames([msg]);
      return c.json(toMessageDTO(msg, senderNames.get(msg.senderId)));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getEvents(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const events = await this.queryMessage.getMessageEvents(id);
      return c.json(events.map(toMessageEventDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async abort(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      /** 仅 Otter 消息可被中止（用户消息已完成，无 Agent 在运行） */
      if (msg.senderType !== "otter") {
        return c.json({ error: "Can only abort otter messages" }, 400);
      }
      /** 仅进行中的消息可被中止——终态消息 abort 会留下 stale abort 标记，污染该消息后续的错误分类 */
      if (!canAbortMessage(msg.status)) {
        return c.json({ error: `Message is already in terminal status: ${msg.status}` }, 409);
      }
      this.agentInvoker.abort(msg.senderId, id);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
