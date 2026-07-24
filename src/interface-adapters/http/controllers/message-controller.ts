import type { Context } from "hono";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";
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
    private readonly maxChainDepth: number = 20,
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
      return handleError(c, err);
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
        attachments: body.attachments,
      });

      /** 3. 首轮立即派发（以持久化后的消息目标为准，含默认解析结果） */
      const firstTurnTargets = userMessage.talkingStonePassedTo ?? [];

      /** 4. 创建 SSE 流（长连接贯穿多轮） */
      const allTargets = new Set(firstTurnTargets);
      const { response, push, close } = streamEvents(c, () => {
        for (const oid of allTargets) {
          this.agentInvoker.abort(oid, "");
        }
      });

      /** 5. 启动调度循环 */
      const dispatchLoop = (targets: string[]) =>
        this.dispatchTurnLoop(targets, { conversationId, userMessageContent: body.body, senderId: body.senderId, allTargets }, push);

      /** 6. 启动调度循环（异常时通知前端并收尾，不静默悬挂 SSE） */
      dispatchLoop(firstTurnTargets)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('发言链调度异常', err instanceof Error ? err : new Error(msg), { conversationId });
          push({ event: "error", data: { message: `发言链调度失败: ${msg}`, messageId: "", otterId: "" } });
        })
        .finally(() => {
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
    while (targets.length > 0 && depth < this.maxChainDepth) {
      depth++;
      for (const id of targets) allTargets.add(id);

      /** 每跳重建名册：链中可能有 otter 被创建/解散 */
      const roster = await this.buildRoster(conversationId);

      const promises = targets.map(async otterId => {
        const messageWithContext = await this.buildMessageWithContext(conversationId, otterId, userMessageContent, senderId, roster);
        this.logger.info('发言链调用', { otterId, messageLength: messageWithContext.length, messagePreview: messageWithContext.substring(0, 200) });
        return this.agentInvoker.invokeConversation({
          otterId, conversationId, userMessageContent: messageWithContext,
          senderId, onSSEEvent: push,
        });
      });
      const results = await Promise.allSettled(promises);

      await this.markBatchRead(conversationId, results);

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

    /** 深度耗尽且仍有待派发目标：显式落地，发言石交还用户（不静默截断） */
    if (targets.length > 0) {
      await this.handleChainDepthExceeded(conversationId, targets, depth, push);
    }
  }

  /** 在场成员名册：name ↔ otterId 映射确定性注入，speak 决策时免费在场 */
  private async buildRoster(conversationId: string): Promise<string> {
    const participants = await this.sendMessageUseCase.repo.getActiveParticipants(conversationId);
    const lines = await Promise.all(participants.map(async p => {
      const otter = await this.queryOtter.getById(p.otterId);
      return `- ${otter?.name ?? p.otterId} (otterId: ${p.otterId})`;
    }));
    lines.push(`- 人类操作者（传 'user' 即交还发言权）`);
    return `## 在场成员\n${lines.join('\n')}`;
  }

  /** 组装派发上下文：名册 + 具名对话历史 + 当前任务 */
  private async buildMessageWithContext(
    conversationId: string,
    otterId: string,
    userMessageContent: string,
    senderId: string,
    roster: string,
  ): Promise<string> {
    const unreadMessages = await this.sendMessageUseCase.repo.getUnreadMessages(conversationId, otterId);
    if (unreadMessages.length === 0) {
      return `${roster}\n\n## 当前任务\n${userMessageContent}`;
    }
    const names = await this.resolveSenderNames(unreadMessages);
    const formatted = unreadMessages
      .map(m => `[${m.senderType === 'system' ? '系统' : m.senderId === senderId ? '用户' : (names.get(m.senderId) ?? m.senderId)}] ${m.body ?? ''}`)
      .join('\n');
    return `${roster}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
  }

  /** 本批派发完成后，将各 otter 的已读位置推进到当前 turn */
  private async markBatchRead(
    conversationId: string,
    results: PromiseSettledResult<{ messageId: string }>[],
  ): Promise<void> {
    const currentTurn = await this.sendMessageUseCase.repo.getActiveTurn(conversationId);
    if (!currentTurn) return;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const msg = await this.queryMessage.getMessageById(r.value.messageId);
      if (msg) {
        await this.sendMessageUseCase.repo.updateLastReadTurnNumber(conversationId, msg.senderId, currentTurn.turnNumber);
      }
    }
  }

  /** 发言链触顶：warn 日志 + 系统消息提示用户接管 */
  private async handleChainDepthExceeded(
    conversationId: string,
    pendingTargets: string[],
    depth: number,
    push: (event: { event: string; data: Record<string, unknown> }) => void,
  ): Promise<void> {
    this.logger.warn('发言链达到深度上限，交还用户', { depth, pendingTargets, conversationId });
    const sysMsg = await this.sendMessageUseCase.sendSystem(
      conversationId,
      `发言接力已达系统安全上限（${this.maxChainDepth} 跳），发言石交还给你。直接回复即可继续——所有参与者会看到未读消息。`,
    );
    push({ event: "system.message", data: { messageId: sysMsg.id, content: sysMsg.body } });
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
      this.agentInvoker.abort(msg.senderId, id);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err);
    }
  }
}
