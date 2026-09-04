import type { Context } from "hono";
import { canAbortMessage, aggregateBody, type Message } from "@entities/conversation/message";
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
import type { QuerySignalTrail } from "@usecases/conversation/query-signal-trail";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import { resolveSpeakerName } from "@usecases/conversation/speaker-resolver";
import { handleError, param } from "../http-error";
import { toMessageDTO, toMessageEventDTO } from "../dto/message-dto";
import { buildMessageDTOs, decorateWithSignals, resolveSenderNames, type MessageDtoBuilderDeps } from "../dto/message-dto-builder";
import type { SendMessageRequestDTO, MarkReadRequestDTO } from "../dto/message-dto";
import { streamEvents } from "../sse-streamer";
import { awaitTriggerAttemptsSettled } from "../sse-settle-waiter";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
/** 多模态 Phase 1（审视修复 R4/R7）：附件注入策略归位 usecases 层——controller 只透传调用 */
import type { AttachmentInjectionService } from "@usecases/conversation/attachment-injection-service";

/* eslint-disable max-lines -- K3（F20260903k23）注入 dispatchAttemptRepo 后 458>450；行数由 DI 参数与入口数量决定，拆分会降低内聚（platforms.ts 同款先例） */
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
    /** 信号轨迹查询（F20260902u5tr）；可选装配，未注入时端点降级 */
    private readonly signalTrail?: QuerySignalTrail,
    /** K3（F20260903k23）：派发台账读——POST SSE 等本轮信号到 attempt 终态再关流（未注入回退旧语义） */
    private readonly dispatchAttemptRepo?: DispatchAttemptRepo,
  ) {}

  /** 批量解析 otter 消息的发送者显示名（dissolve 不删行，永远可解析） */
  /** DTO 组装 helper 依赖包（F20260828c4sg 合并适配：从本类拆出，见 message-dto-builder.ts） */
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
      const dtos = await buildMessageDTOs(messages, this.dtoBuilder);
      const hasMore = messages.length === limit
        && messages.length > 0
        && messages[messages.length - 1].sequenceNum > 1;
      return c.json({ messages: dtos, hasMore });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** after 游标向下分页：加载比 after 消息更新的历史消息（升序） */
  async listAfter(c: Context): Promise<Response> {
    try {
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
      const after = c.req.query("after");
      if (!after) {
        return c.json({ error: "after parameter is required" }, 400);
      }
      const messages = await this.queryMessage.getMessagesAfter(after, limit);
      const dtos = await buildMessageDTOs(messages, this.dtoBuilder);
      const hasMore = messages.length === limit;
      return c.json({ messages: dtos, hasMore });
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
      const requestError = this.validateSendMessageRequest(body);
      if (requestError) return requestError;

      /** 多模态 Phase 1：附件前置校验（usecases 层策略：存在性 + 每轮 ≤2 图硬限制）。
       *  R4/R7 同步组装注入载荷（一次 getByIds，避免二次查询）。 */
      const payload = await this.attachmentInjection?.validateAndBuild(body.attachmentIds);
      if (typeof payload === "string") return c.json({ error: payload }, 400);

      /** 2. 创建用户消息（completed 状态），空目标会被解析为默认派发对象 */
      const { message: userMessage, mentionFeedback } = await this.sendMessageUseCase.send({
        conversationId,
        senderId: body.senderId,
        talkingStonePassedTo: body.talkingStonePassedTo ?? [],
        body: body.body,
        ...(body.attachmentIds && body.attachmentIds.length > 0 && { attachmentIds: body.attachmentIds }),
      });

      // 广播用户消息到外部渠道（飞书等）
      this.broadcastUserMessage(userMessage, conversationId);

      return this.streamDispatchResponse(c, { conversationId, body, userMessage, mentionFeedback, payload });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 广播用户消息到外部渠道（fire-and-forget，自 sendMessage 拆出） */
  private broadcastUserMessage(userMessage: Message, conversationId: string): void {
    if (!this.messageBroadcaster) return;
    this.messageBroadcaster.broadcast(userMessage).catch(err => {
      this.logger.error("Failed to broadcast user message", err instanceof Error ? err : undefined, {
        conversationId,
        messageId: userMessage.id,
      });
    });
  }

  /** POST SSE 流 + 调度循环启动（自 sendMessage 拆出）。
   *  多模态 Phase 1（审视修复 R4/R7）：注入载荷已随前置校验组装（validateAndBuild）——
   *  image 真图 + document 文本块；≤2 图硬限制已拒绝；未读历史统一文本投影在 dispatch-chain-engine 内做。 */
  private streamDispatchResponse(
    c: Context,
    ctx: {
      conversationId: string;
      body: SendMessageRequestDTO;
      userMessage: Message;
      mentionFeedback?: string;
      payload?: Awaited<ReturnType<AttachmentInjectionService["validateAndBuild"]>>;
    },
  ): Response {
    const { conversationId, body, userMessage, mentionFeedback, payload } = ctx;
    /** 首轮立即派发（以持久化后的消息目标为准，含默认解析结果） */
    const firstTurnTargets = userMessage.talkingStonePassedTo ?? [];

    // F20260903ihlt：用户发新消息 = 显式恢复动作——解除中断停机（多模态直连链分支同样覆盖）
    this.signalRouter?.clearUserHalt(conversationId);

    /** SSE 流（长连接贯穿多轮）。客户端断开不中止 Agent——发言生命周期由后端状态机管理（UA-刷新续跑） */
    const allTargets = new Set(firstTurnTargets);
    const { response, push, close } = streamEvents(c);

    // F20260820i333 + 广播订阅收口
    const unsubscribe = this.subscribeBroadcasterForPostStream(conversationId, push, mentionFeedback);

    const injection = payload && typeof payload !== "string" ? payload : undefined;
    // F20260901sgpv P1：主入口火车头换轨——调度收敛到信号路由器（投递即点火）。
    // Why 路由器优先：四入口各自直调 executeChain 是旧架构的核心痛点（T1），“插话撞
    // 锁超时”的根因即在此；未注入路由器时降级直连链（灰度回滚面，行为与现状等价）。
    // K3（F20260903k23）：SSE 生命周期挂台账终态——本轮信号 attempt 全部到终态或超时才关流。
    if (this.signalRouter && !injection) {
      // Why !injection（多模态例外）：带图片/文档注入的消息暂留直连链——注入载荷只存在于此请求内存中，
      // 信号路由从消息表重建内容拿不到它（多模态×信号路由的统一归 P2 接缝层解决）
      this.signalRouter.routePendingSignals(conversationId)
        .then(async (results) => {
          // S3.5（F20260903s35u，G6）：熔断/停机导致本轮信号全部被闸门挡下时，
          // 落一条系统消息告知用户——HTTP 200 + 零反馈是最差交互组合；「已排队待恢复」
          // 要说清楚（信号保留，闸门解除后自动处理）。
          if (results.length > 0 && results.some(r => r.action === "skipped_rate_limited" || r.action === "skipped_halted")) {
            const gate = await this.signalRouter!.getGateState(conversationId);
            const reason = gate.halted
              ? "会话已停机（你按过中断），发新消息即恢复调度"
              : gate.rateLimitedUntil
                ? `模型限流冷却中（至 ${new Date(gate.rateLimitedUntil).toLocaleTimeString('sv-SE', { hour12: false })}），消息已排队、恢复后自动处理`
                : "调度闸门暂缓，消息已排队";
            await this.sendMessageUseCase.sendSystem(conversationId, reason).catch(() => {});
          }
          // K3 审视焦点 3（#757）：全部 skipped（如 HALT 到小獭被丢弃、dissolved 目标）
          // 时永不产生 attempt 行——等 settle 只会白等满 30s。直接关流（signal 在消息表
          // 持久，状态由轨迹 UI 承载）；混合场景（有 invoked/queued_busy）仍走终态等待。
          return results.length > 0 && results.every(r => r.action.startsWith("skipped"))
            ? undefined
            : awaitTriggerAttemptsSettled(this.dispatchAttemptRepo, this.logger, conversationId, userMessage.id)
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
        push({ event: "error", data: { message: `发言链调度失败: ${msg}`, messageId: "", otterId: "" } });
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

  /** retry 目标前置校验（自 retry 拆出控复杂度）：otter 消息 + 可重试状态（存在性已查） */
  private precheckRetryTarget(msg: { status: string; senderType: string }): Response | null {
    if (msg.senderType !== "otter") {
      return Response.json({ error: "Can only retry otter messages" }, { status: 400 });
    }
    if (msg.status !== "failed" && msg.status !== "aborted") {
      return Response.json({ error: `Message is not in a retryable status: ${msg.status}` }, { status: 409 });
    }
    return null;
  }

  /** retry 链启动（自 retry 拆出控复杂度）：SSE 流 + broadcaster 订阅 + executeChain */
  /** F20260902sgp2 S3：retry 换轨路径——过路由器闸门（限流熔断中被挡如实反馈 retry_gated），
   *  记账 source='retry'，与自动点火共用 invokeTarget（busyQueue 排队语义一致）。
   *  修复的漏洞：retry 曾直连 executeChain 绕过全部调度闸门——限流熔断期间手动 retry
   *  照跑撞 429 → 熔断窗口重置 → 自动点火继续冻结（09-03 会议定性，搭档实锤）。 */
  private retryViaRouterPath(args: {
    conversationId: string; otterId: string; messageId: string; senderId: string;
    signal: Message; unsubscribe: (() => void) | undefined;
    push: (event: { event: string; data: Record<string, unknown> }) => void;
    close: () => void; response: Response;
  }): Response {
    const { conversationId, otterId, messageId, signal, unsubscribe, push, close, response } = args;
    void this.signalRouter!.retrySignal(conversationId, messageId, otterId, signal)
      .then((action) => {
        if (action === "retry_gated") {
          push({ event: "system.message", data: { content: "调度闸门暂缓：限流冷却中或会话已停机，重试将在恢复后可再次执行", messageId, otterId } });
        }
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('retrySignal 调度异常', err instanceof Error ? err : new Error(errMsg), { conversationId, messageId });
        push({ event: "error", data: { message: `重试失败: ${errMsg}`, messageId, otterId } });
      })
      .finally(() => {
        unsubscribe?.();
        // retry 的 settle 等待：与 K3 同语义——attempt 终态驱动关流（失败也是终态）
        void this.settleRetrySse(conversationId, messageId).finally(() => {
          // 与主路径 K3 一致：settle 已等 attempt 终态，直接关流（无 100ms 缓冲——
          // 那是「路由器未注入降级路径」的旧语义，settle 语义下无必要）
          push({ event: "stream.end", data: {} });
          close();
        });
      });
    return response;
  }

  /** S3：retry 换轨后的 SSE settle 等待（与 K3 同语义——attempt 终态驱动关流） */
  private async settleRetrySse(conversationId: string, messageId: string): Promise<void> {
    await awaitTriggerAttemptsSettled(this.dispatchAttemptRepo, this.logger, conversationId, messageId);
  }

  private startRetryChain(
    c: Context,
    ctx: { conversationId: string; otterId: string; messageId: string; userMessageContent: string; senderId: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; signal?: Message },
  ): Response {
    const { conversationId, otterId, messageId, userMessageContent, senderId, images, signal } = ctx;
    const { response, push, close } = streamEvents(c);

    // F20260903ihlt：手动 retry = 用户显式恢复动作——解除中断停机，冻结的 pending 随链收尾重扫恢复
    this.signalRouter?.clearUserHalt(conversationId);

    let unsubscribe: (() => void) | undefined;
    if (this.messageBroadcaster) {
      unsubscribe = this.messageBroadcaster.subscribe(
        conversationId,
        () => {},
        (event) => { push(event); },
      );
    }

    // F20260902sgp2 S3（09-03 会议整改，堵闸门绕过漏洞）：路由器在位且带信号实体 → 换轨；
    // 降级（未注入/直写库无信号实体）→ 保留直连链。见 retryViaRouterPath。
    if (this.signalRouter && signal) {
      return this.retryViaRouterPath({ conversationId, otterId, messageId, senderId, signal, unsubscribe, push, close, response });
    }

    // Why: 通过 DispatchChainEngine 执行而非直接 invoke——
    // 链引擎消费 aggregatedTargets 续跑发言链，直接 invoke 会丢弃 yield 传递目标（#332）
    this.dispatchChainEngine.executeChain({
      conversationId,
      userMessageContent,
      senderId,
      initialTargets: [otterId],
      ...(images && { images }),
      // S1：retry 的触发消息 = 被重试的 otter 消息（记账目标为该 otter）
      triggerMessageId: messageId,
      invokeFn: async (params) => this.agentInvoker.invokeConversation({
        otterId: params.otterId,
        conversationId: params.conversationId,
        userMessageContent: params.userMessageContent,
        senderId: params.senderId,
        ...(params.images && { images: params.images }),
        retryCount: 1,
        manualRetry: true,
      }),
    })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('重试调度异常', err instanceof Error ? err : new Error(errMsg), { conversationId, messageId });
        push({ event: "error", data: { message: `重试失败: ${errMsg}`, messageId, otterId } });
      })
      .finally(() => {
        unsubscribe?.();
        setTimeout(() => { push({ event: "stream.end", data: {} }); close(); }, 100);
      });

    return response;
  }

  /** 重试路径注入载荷：从原 user 消息 attachments 重新组装（审视修复 R9；无附件/未装配时 undefined） */
  private async loadRetryInjection(attachments?: Array<{ id: string }>): Promise<Awaited<ReturnType<AttachmentInjectionService["buildInjectionPayload"]>>> {
    if (!attachments || attachments.length === 0) return undefined;
    if (!this.attachmentInjection?.available) return undefined;
    return this.attachmentInjection.buildInjectionPayload(attachments.map(a => a.id));
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
    const sysMsg = await this.sendMessageUseCase.sendSystem(
      conversationId,
      `行动权接力已达系统安全上限（${depth} 跳），行动权交还给你。直接回复即可继续——所有参与者会看到未读消息。`,
    );
    if (this.messageBroadcaster) {
      this.messageBroadcaster.broadcastEvent(conversationId, { event: "system.message", data: { messageId: sysMsg.id, content: aggregateBody(sysMsg.segments), seq: sysMsg.sequenceNum } });
    }
  }

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      const senderNames = await resolveSenderNames([msg], this.queryOtter);
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
      // F20260903ihlt：中断 = 会话级停机——只 abort 本条消息的 SDK session 时，
      // 路由器 50ms 去抖重扫会立刻点火下一只 pending 獭（09-03 现场：中断 a 弹出 b）。
      // 置 halt 冻结本会话全部 pending 点火，用户发新消息/手动 retry 时解除。
      this.signalRouter?.markUserHalt(msg.conversationId);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 手动重试：对 failed/aborted 的 otter 消息重新触发 agent 执行 */
  async retry(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const msg = await this.queryMessage.getMessageById(id);
      if (!msg) {
        return c.json({ error: "Message not found" }, 404);
      }
      const precheck = this.precheckRetryTarget(msg);
      if (precheck) return precheck;

      const conversationId = msg.conversationId;
      const otterId = msg.senderId;

      // 原始用户消息内容：从同 turn 的 user 消息中取
      // turn 关系由 turnId 关联，但 QueryMessage 无 getMessagesByTurnId；
      // 用 body 中保留的原始 prompt 或兜底空串（session 上下文已完整）
      const userMessageContent = aggregateBody(msg.segments);

      // 获取原始 user senderId（发言石应传回给用户，不能用 otterId）
      const turnUserMsgs = await this.queryMessage.getMessages(conversationId, { turnId: msg.turnId, senderType: "user", limit: 1 });
      const senderId = turnUserMsgs[0]?.senderId ?? "user";

      /** 多模态 Phase 1（审视修复 R9）：重试路径从原 user 消息 attachments 重新组装注入载荷——
       *  session 历史未重启时图仍在，但 self-restart/换 session 后当前任务图不缺席 */
      const retryPayload = await this.loadRetryInjection(turnUserMsgs[0]?.attachments);
      const contentWithDocs = this.withDocumentBlock(userMessageContent, retryPayload?.documentBlock);

      return this.startRetryChain(c, {
        conversationId, otterId, messageId: id,
        userMessageContent: contentWithDocs, senderId,
        images: retryPayload?.images,
        // S3：retry 信号实体（档位/内容/发送者）——路由器 retrySignal 的闸门与记账输入
        signal: msg,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
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

  /** 信号轨迹（F20260902u5tr）：投石信号对目标 otter 的投递状态（服务端持久层推导） */
  async getSignalTrail(c: Context): Promise<Response> {
    try {
      if (!this.signalTrail) {
        return c.json({ error: "signal trail not configured" }, 501);
      }
      const conversationId = param(c, "id");
      const trail = await this.signalTrail.list(conversationId);
      // S3.5（F20260903s35u）：附带会话调度闸门状态（横幅数据源，与轨迹同端点一次取全，
      // 前端轮询无需新增请求）。路由器未注入（降级直连链）时 gate 为 null——横幅不渲染。
      const gate = this.signalRouter ? await this.signalRouter.getGateState(conversationId) : null;
      return c.json({ ...trail, gate });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** F20260902sgp2 S1 观测端点：pending 计数裸探针（机器可读，监控/核查用；
   *  与 /signal-trail 分离——那是给人的投影，这是账面的数字） */
  async getPendingCount(c: Context): Promise<Response> {
    try {
      if (!this.dispatchAttemptRepo) {
        return c.json({ error: "dispatch attempt repo not configured" }, 501);
      }
      const conversationId = param(c, "id");
      const count = this.dispatchAttemptRepo.countPendingSignals(conversationId);
      return c.json({ conversationId, pending: count });
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

  /** 加载目标消息上下文（搜索跳转 / 未读窗口加载用） */
  async expand(c: Context): Promise<Response> {
    try {
      const messageId = param(c, "id");
      const direction = (c.req.query("direction") ?? "both") as "before" | "after" | "both";
      const rawCount = Number(c.req.query("count") ?? "25");
      const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 25;
      const messages = await this.queryMessage.expandMessage(messageId, direction, count);
      const dtos = await buildMessageDTOs(messages, this.dtoBuilder);
      return c.json(dtos);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
