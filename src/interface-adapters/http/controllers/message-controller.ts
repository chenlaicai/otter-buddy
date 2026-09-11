import type { Context } from "hono";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { SSEEvent } from "@contract/sse/events";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SignalRouter } from "@usecases/conversation/signal-router";
import type { SendEntry } from "@usecases/conversation/send-entry";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";
import { handleError, param } from "../http-error";
import { toMessageDTO } from "../dto/message-dto";
import { decorateWithSignals, type MessageDtoBuilderDeps } from "../dto/message-dto-builder";
import type { SendMessageRequestDTO, MarkReadRequestDTO } from "../dto/message-dto";
import { streamEvents } from "../sse-streamer";
import { awaitTriggerAttemptsSettled } from "../sse-settle-waiter";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
/** 多模态 Phase 1（审视修复 R4/R7）：附件注入策略归位 usecases 层——controller 只透传调用 */
 
import type { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";


export class MessageController {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定
  constructor(
    private readonly sendMessageUseCase: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly manageReadState: ManageReadState,
    private readonly agentInvoker: AgentInvoker,
    private readonly logger: Logger,
    private readonly queryOtter: QueryOtter,
    private readonly dispatchChainEngine: DispatchChainEngine,
    private readonly messageBroadcaster?: MessageBroadcaster,
    /** F20260826mwrd C4：消息 DTO signals 挂载（徽章数据源） */
    private readonly signalRepo?: SignalEventRepository,
    /** 多模态 Phase 1（审视修复 R4/R7）：附件注入服务（usecases 层策略——校验+真图+document 文本）；可选装配 */
    private readonly attachmentInjection?: AttachmentInjectionService,
    /** F20260901sgpv P1：信号路由器——主入口调度收敛（火车头换轨）。可选注入：
     *  未注入时降级田直连链（旧装配/存量测试不变，灰度回滚面） */
    private readonly signalRouter?: SignalRouter,
    /** F20260910ctlv 切换清扫：user 消息双写 entries（时间线真相源） */
    private readonly sendEntry?: SendEntry,
    /** F20260910ctlv 补漏：settle 判据数据源（K3 关流读 entries/invokes） */
    private readonly settleEntryRepo?: EntryRepository,
    private readonly settleInvokeRepo?: InvokeRepository,
  ) {}

  /** 批量解析 otter 消息的发送者显示名（dissolve 不删行，永远可解析） */
  /** DTO 组装 helper 依赖包（F20260828c4sg 合并适配：从本类拆出，见 message-dto-builder.ts） */
  /** F20260910ctlv：settle 判据数据源（entries tsp + invokes running） */
  private settleRepos(): { entryRepo?: EntryRepository; invokeRepo?: InvokeRepository } {
    return { entryRepo: this.settleEntryRepo, invokeRepo: this.settleInvokeRepo };
  }

  private get dtoBuilder(): MessageDtoBuilderDeps {
    return { queryOtter: this.queryOtter, queryMessage: this.queryMessage, signalRepo: this.signalRepo, logger: this.logger };
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
        try {
          this.logger.info("[subscribe] Broadcasting message to SSE", {
            conversationId,
            messageId: message.id,
            senderType: message.senderType,
          });
          // 解析发送者名称（与 list/getById 一致，避免 subscribe 遗漏 sn 导致前端显示 "Otter"）
          let senderName: string | undefined;
          if (message.senderType === "otter") {
            const otter = await this.queryOtter.getById(message.senderId);
            senderName = resolveSpeakerName("otter", message.senderId, otter?.name) ?? undefined;
          } else if (message.senderType === "user") {
            senderName = "我";
          } else {
            senderName = "系统";
          }
          push({
            event: "message",
            data: (await decorateWithSignals(toMessageDTO(message, senderName), message, this.dtoBuilder)) as unknown as Record<string, unknown>,
          });
        } catch (err) {
          this.logger.error("[subscribe] Failed to broadcast message", err instanceof Error ? err : undefined, { messageId: message.id });
          // 降级：名称解析失败也要推送消息（前端回退到 otterId/其他名称解析）；信号挂载失败不阻断推送（徽章缺失可由前端刷新拉齐）
          try {
            push({
              event: "message",
              data: (await decorateWithSignals(toMessageDTO(message), message, this.dtoBuilder)) as unknown as Record<string, unknown>,
            });
          } catch {
            push({
              event: "message",
              data: toMessageDTO(message) as unknown as Record<string, unknown>,
            });
          }
        }
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

  /** 多模态附件前置校验（#826 收口：路由器在位时仅校验不组装——路由器消费信号时从 attachments 重建） */
  private async validateAttachmentPayload(attachmentIds?: string[]): Promise<Response | Awaited<ReturnType<AttachmentInjectionService["validateAndBuild"]>>> {
    const payload = this.signalRouter
      ? await this.attachmentInjection?.validateForSendOnly(attachmentIds) ?? undefined
      : await this.attachmentInjection?.validateAndBuild(attachmentIds);
    if (typeof payload === "string") {
      return Response.json({ error: payload }, { status: 400 });
    }
    return payload;
  }

  async sendMessage(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const body = await c.req.json<SendMessageRequestDTO>();

      /** 1. 校验请求体（在写入 DB 之前，避免孤儿消息）。
     *  talkingStonePassedTo 允许为空：无 @ 时由 usecase 层按领域规则解析默认目标 */
      const requestError = this.validateSendMessageRequest(body);
      if (requestError) return requestError;

      /** 多模态 Phase 1：附件前置校验（usecases 层策略：存在性 + 每轮 ≤2 图硬限制） */
      const payloadResult = await this.validateAttachmentPayload(body.attachmentIds);
      if (payloadResult instanceof Response) return payloadResult;
      const payload = payloadResult;

      /** 2. F20260910ctlv 彻底切换：user 消息唯一落点 = entries（messages 表停写）。
       *  目标解析（默认派发/@提及）在 SendEntry 内完成；显式目标透传；talkingStonePassedTo 是点火依据 */
      const { entry: userEntry, talkingStonePassedTo, mentionFeedback } = await this.sendEntry!.sendUserEntry({
        conversationId,
        senderId: body.senderId,
        body: body.body,
        source: "web",
        talkingStonePassedTo: body.talkingStonePassedTo ?? [],
        ...(body.attachmentIds && body.attachmentIds.length > 0 && { attachmentIds: body.attachmentIds }),
      });

      /** 附件关联（多模态）：user entry 挂附件（内存载荷仅降级直连链用） */
      if (body.attachmentIds && body.attachmentIds.length > 0) {
        await this.sendEntry!.attachEntryAttachments(userEntry.id, body.attachmentIds).catch((err: unknown) => {
          this.logger.warn('Failed to attach entry attachments', { entryId: userEntry.id, error: err instanceof Error ? err.message : String(err) });
        });
      }

      /** 广播 entry 事件（user 气泡，前端 entry 通道消费；旧 message 广播已退役） */
      if (this.messageBroadcaster) {
        this.messageBroadcaster.broadcastEvent(conversationId, {
          event: "entry.user",
          data: { entryId: userEntry.id, sequenceNum: userEntry.sequenceNum, senderId: body.senderId, body: body.body, createdAt: userEntry.createdAt },
        });
      }

      /** 兼容路由器：routeSignals 读 messages 行的 tsp——构造轻量 message 视图（不入库） */
      const userMessage = {
        id: userEntry.id,
        conversationId,
        senderType: "user" as const,
        senderId: body.senderId,
        talkingStonePassedTo,
        status: "completed" as const,
        segments: [],
        sequenceNum: userEntry.sequenceNum,
      };

      return this.streamDispatchResponse(c, { conversationId, body, userMessage, mentionFeedback, payload, entryId: userEntry.id });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** POST SSE 流 + 调度循环启动（自 sendMessage 拆出）。
   *  多模态 Phase 1（审视修复 R4/R7）：注入载荷已随前置校验组装（validateAndBuild）——
   *  image 真图 + document 文本块；≤2 图硬限制已拒绝；未读历史统一文本投影在 dispatch-chain-engine 内做。 */
  private streamDispatchResponse(
    c: Context,
    ctx: {
      conversationId: string;
      body: SendMessageRequestDTO;
      /** F20260910ctlv 彻底切换：路由器信号视图（轻量内存对象，不入库） */
      userMessage: { id: string; conversationId: string; senderType: "user"; senderId: string; talkingStonePassedTo: string[]; status: "completed"; segments: never[]; sequenceNum: number };
      mentionFeedback?: string;
      payload?: Awaited<ReturnType<AttachmentInjectionService["validateAndBuild"]>>;
      /** F20260910ctlv：user entry id（触发锚） */
      entryId: string;
    },
  ): Response {
    const { conversationId, body, userMessage, mentionFeedback, payload } = ctx;
    /** 首轮立即派发（以解析后的目标为准，含默认解析结果） */
    const firstTurnTargets = userMessage.talkingStonePassedTo ?? [];

    /** SSE 流（长连接贯穿多轮）。客户端断开不中止 Agent——发言生命周期由后端状态机管理（UA-刷新续跑） */
    const allTargets = new Set(firstTurnTargets);
    const { response, push, close } = streamEvents(c);

    // F20260820i333 + 广播订阅收口
    const unsubscribe = this.subscribeBroadcasterForPostStream(conversationId, push, mentionFeedback);

    const injection = payload && typeof payload !== "string" ? payload : undefined;
    // F20260901sgpv P1：主入口火车头换轨——调度收敛到信号路由器（投递即点火）。
    // K3（F20260908rlcp）：SSE 生命周期挂消息终态——本轮信号到终态或超时才关流。
    if (this.signalRouter) {
      // F20260908rlcp 整合修复：传入 triggerMessageId 只路由本轮触发消息——
      // 不扫历史（历史已处理信号的重复点火是 09-09 实测双触发根因）
      this.signalRouter.routeSignals(conversationId, { triggerMessageId: userMessage.id })
        .then(async (results) => {
          return results.length > 0 && results.every(r => r.action.startsWith("skipped"))
            ? undefined
            : awaitTriggerAttemptsSettled(this.settleRepos(), this.logger, conversationId, userMessage.id)
                .catch(e => this.logger.warn("[k3] settle 轮询异常（兜底关流）", { conversationId, error: e instanceof Error ? e.message : String(e) }));
        })
        .finally(() => {
          unsubscribe?.();
          push({ event: "stream.end", data: {} });
          close();
        });
      return response;
    }
    this.dispatchTurnLoop(firstTurnTargets, {
      conversationId, userMessageContent: this.withDocumentBlock(body.body, injection?.documentBlock),
      senderId: body.senderId, allTargets, images: injection?.images,
      // F20260902sgp2 S1：触发消息 ID（派发台账首 hop 记账）
      triggerMessageId: userMessage.id,
    })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error('发言链调度异常', err instanceof Error ? err : new Error(msg), { conversationId });
        push({ event: "error", data: { message: `发言链调度失败: ${msg}`, otterId: "" } });
      })
      .finally(() => {
        // 清理订阅，防止内存泄漏
        unsubscribe?.();
        // 兜底：如果 subscribe 回调没有关闭流（如无 agent 事件），在此关闭
        setTimeout(() => { push({ event: "stream.end", data: {} }); close(); }, 100);
      });

    return response;
  }

  /** sendMessage 请求体校验（自 sendMessage 拆出控复杂度） */
  private validateSendMessageRequest(body: SendMessageRequestDTO): Response | null {
    if (!body.senderId) {
      return Response.json({ error: "senderId is required" }, { status: 400 });
    }
    if (!body.body) {
      return Response.json({ error: "body is required" }, { status: 400 });
    }
    return null;
  }

  /** document 提取块追加在正文之后（多模态 Phase 1 审视修复 R9：方案 §3.4① 注入格式） */
  private withDocumentBlock(body: string, documentBlock?: string): string {
    return documentBlock ? `${body}\n\n${documentBlock}` : body;
  }

  /** POST SSE 流的 broadcaster 订阅 + mentionFeedback 推送（自 sendMessage 拆出） */
  private subscribeBroadcasterForPostStream(
    conversationId: string,
    push: (event: SSEEvent) => void,
    mentionFeedback?: string,
  ): (() => void) | undefined {
    // F20260820i333: 发送 @提及解析 feedback 给用户
    if (mentionFeedback) {
      push({ event: 'mention.feedback', data: { feedback: mentionFeedback } });
    }
    if (!this.messageBroadcaster) return undefined;
    return this.messageBroadcaster.subscribe(
      conversationId,
      // onMessage 为空：POST SSE 流仅接收当前请求触发的 agent 事件（通过 onEvent）。
      // 其他消息（飞书用户消息等）通过 GET SSE 订阅接收，避免重复推送。
      () => {},
      // onEvent：streaming 事件 → 推送到 POST SSE 流
      (event) => { push(event); },
    );
  }

  /** Turn 级调度循环：派发一批 otter → 等待全部完成 → 聚合 turn → 派发下一轮 */
  private async dispatchTurnLoop(
    targets: string[],
    ctx: { conversationId: string; userMessageContent: string; senderId: string; allTargets: Set<string>; images?: Array<{ type: "image"; data: string; mimeType: string }>; triggerMessageId?: string },
  ): Promise<void> {
    const { conversationId, userMessageContent, senderId, allTargets, images, triggerMessageId } = ctx;

    // 使用 DispatchChainEngine 执行发言链（事件通过 broadcastEvent 统一推送到订阅者）
    await this.dispatchChainEngine.executeChain({
      conversationId,
      userMessageContent,
      senderId,
      initialTargets: targets,
      // F20260902sgp2 S1：触发消息 ID（首 hop 派发记账）
      triggerMessageId,
      ...(images && { images }),
      invokeFn: async (params) => {
        for (const id of params.otterId ? [params.otterId] : []) allTargets.add(id);
        return this.agentInvoker.invokeConversation({
          otterId: params.otterId,
          conversationId: params.conversationId,
          userMessageContent: params.userMessageContent,
          senderId: params.senderId,
          ...(params.images && { images: params.images }),
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
    // F20260910ctlv 彻底切换：链深通知只写 entries（system entry）
    const { entry: sysEntry } = await this.sendEntry!.createSystemEntry({
      conversationId,
      turnId: "",
      body: `行动权接力已达系统安全上限（${depth} 跳），行动权交还给你。直接回复即可继续——所有参与者会看到未读消息。`,
    });
    if (this.messageBroadcaster) {
      this.messageBroadcaster.broadcastEvent(conversationId, { event: "entry.system", data: { entryId: sysEntry.id, content: sysEntry.body, seq: sysEntry.sequenceNum } });
    }
  }

  /** 未读状态（消息级，基于 last_read_message_seq） */
  async getUnreadState(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const userId = c.req.query("userId") ?? "web-user";
      const state = await this.queryMessage.getUnreadState(conversationId, userId);
      return c.json(state);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 标记已读（只前进不后退） */
  async markRead(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const userId = c.req.query("userId") ?? "web-user";
      const body = await c.req.json<MarkReadRequestDTO>();
      if (typeof body.messageSeq !== "number" || body.messageSeq < 0) {
        return c.json({ error: "messageSeq must be a non-negative number" }, 400);
      }
      const result = await this.manageReadState.markRead(conversationId, userId, body.messageSeq);
      return c.json(result);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

}
