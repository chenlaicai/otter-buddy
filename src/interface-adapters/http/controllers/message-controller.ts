import type { Context } from "hono";
import { canAbortMessage } from "@entities/conversation/message";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";
import { toMessageDTO, toMessageEventDTO } from "../dto/message-dto";
import type { SendMessageRequestDTO } from "../dto/message-dto";
import { streamEvents } from "../sse-streamer";

export class MessageController {
  constructor(
    private readonly sendMessageUseCase: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly agentInvoker: AgentInvoker,
    private readonly logger: Logger,
  ) {}

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
      const dtos = messages.map((msg) => {
        const dto = toMessageDTO(msg);
        const evts = eventsByMsg.get(msg.id);
        if (evts && evts.length > 0) {
          dto.events = evts.map(toMessageEventDTO);
        }
        return dto;
      });
      return c.json(dtos);
    } catch (err) {
      return handleError(c, err);
    }
  }

  async sendMessage(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<SendMessageRequestDTO>();

      /** 1. 校验请求体（在写入 DB 之前，避免孤儿消息） */
      if (!body.talkingStonePassedTo || body.talkingStonePassedTo.length === 0) {
        return c.json({ error: "talkingStonePassedTo must be non-empty" }, 400);
      }
      if (!body.senderId) {
        return c.json({ error: "senderId is required" }, 400);
      }
      if (!body.body) {
        return c.json({ error: "body is required" }, 400);
      }

      /** 2. 创建用户消息（completed 状态） */
      const _userMessage = await this.sendMessageUseCase.send({
        conversationId,
        senderId: body.senderId,
        talkingStonePassedTo: body.talkingStonePassedTo,
        body: body.body,
        attachments: body.attachments,
      });

      /** 3. 首轮立即派发（用户消息的 talkingStonePassedTo） */
      const firstTurnTargets = body.talkingStonePassedTo;

      /** 4. 创建 SSE 流（长连接贯穿多轮）。客户端断开不中止 Agent——发言生命周期由后端状态机管理（UA-刷新续跑） */
      const allTargets = new Set(firstTurnTargets);
      const { response, push, close } = streamEvents(c);

      /** 5. 启动调度循环 */
      const dispatchLoop = (targets: string[]) =>
        this.dispatchTurnLoop(targets, { conversationId, userMessageContent: body.body, senderId: body.senderId, allTargets }, push);

      /** 6. 启动调度循环 */
      dispatchLoop(firstTurnTargets).then(() => {
        push({ event: "stream.end", data: {} });
        close();
      });

      return response;
    } catch (err) {
      return handleError(c, err);
    }
  }

  /** Turn 级调度循环：派发一批 otter → 等待全部完成 → 聚合 turn → 派发下一轮 */
  private async dispatchTurnLoop(
    targets: string[],
    ctx: { conversationId: string; userMessageContent: string; senderId: string; allTargets: Set<string> },
    push: (event: { event: string; data: Record<string, unknown> }) => void,
  ): Promise<void> {
    const { conversationId, userMessageContent, senderId, allTargets } = ctx;
    let depth = 0;
    while (targets.length > 0 && depth < 5) {
      depth++;
      for (const id of targets) allTargets.add(id);

      const promises = targets.map(async otterId => {
        const unreadMessages = await this.sendMessageUseCase.repo.getUnreadMessages(conversationId, otterId);
        let messageWithContext = userMessageContent;
        if (unreadMessages.length > 0) {
          const formatted = unreadMessages
            .map(m => `[${m.senderType === 'system' ? '系统' : m.senderId === senderId ? '用户' : m.senderId}] ${m.body ?? ''}`)
            .join('\n');
          messageWithContext = `## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
        }
        this.logger.info('发言链调用', { otterId, unreadCount: unreadMessages.length, messageLength: messageWithContext.length, messagePreview: messageWithContext.substring(0, 200) });
        return this.agentInvoker.invokeConversation({
          otterId, conversationId, userMessageContent: messageWithContext,
          senderId, onSSEEvent: push,
        });
      });
      const results = await Promise.allSettled(promises);

      const currentTurn = await this.sendMessageUseCase.repo.getActiveTurn(conversationId);
      if (currentTurn) {
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const msg = await this.queryMessage.getMessageById(r.value.messageId);
          if (msg) {
            await this.sendMessageUseCase.repo.updateLastReadTurnNumber(conversationId, msg.senderId, currentTurn.turnNumber);
          }
        }
      }

      const nextTargets = new Set<string>();
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.aggregatedTargets) {
          for (const id of r.value.aggregatedTargets) {
            nextTargets.add(id);
          }
        }
      }
      targets = [...nextTargets].filter(id => id !== senderId);
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      return c.json(toMessageDTO(msg));
    } catch (err) {
      return handleError(c, err);
    }
  }

  async getEvents(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const events = await this.queryMessage.getMessageEvents(id);
      return c.json(events.map(toMessageEventDTO));
    } catch (err) {
      return handleError(c, err);
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
      /** 仅进行中的消息可被中止——终态消息 abort 会留下 stale abortedOtters 标记，污染该 otter 下次 invoke 的错误分类 */
      if (!canAbortMessage(msg.status)) {
        return c.json({ error: `Message is already in terminal status: ${msg.status}` }, 409);
      }
      this.agentInvoker.abort(msg.senderId, id);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err);
    }
  }
}
