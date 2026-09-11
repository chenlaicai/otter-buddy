/**
 * F20260908rlcp：信号路由器（事件驱动终态）。
 *
 * 职责：把「消息表里的信号」路由为 invoke 或 followUp/steer——入口（web sendMessage / IM / resume
 * 补扫 / scheduler·招聘直投 routeDirectSignal）的调度收敛点。
 *
 * F20260908rlcp 改动摘要（与 F20260901sgpv 对比）：
 * - 退役：busyQueue / QueuedSignal / drainBusyQueue / signalContent / rebuildInjection
 *   / userHalted / markUserHalt / clearUserHalt / isRateLimited / RATE_LIMIT_BLOCK_*
 *   / shouldThrottle / isOtterActive / DEBOUNCE_MS / ACTIVE_WINDOW_MS / MIN_INVOKE_INTERVAL_SEC
 *   / getGateState / routeAllPending / haltToSmallOtterGuard / buildSteerPrompt / trySteerInjection
 *   / scheduleDebounceRescan / attachachmentInjection / DispatchAttemptRepo / agentGateway
 * - 新增：factory（PiSessionFactory 窄接口：isRunning/followUp/steerSession）
 * - routePendingSignals → routeSignal（事件驱动路由）
 * - 档位概念移除：NORMAL/URGENT/HALT → followUp（默认）/ steer（标急）/ abort（session 方法调用）
 */
import type { Message } from "@entities/conversation/message";
import type { Entry } from "@entities/conversation/entry";
import type { EntryRepository } from "./entry-repository";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingErrorType, HealingEventStatus, HealingEvent, HealingSeverity } from "@entities/healing/healing-event";

/** invoke 函数签名（与 AgentInvoker.invokeConversation 对齐的最小面；装配处闭包捕获 agentInvoker） */
export type SignalRouterInvokeFn = (params: {
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
}) => Promise<{ messageId: string; aggregatedTargets?: string[] }>;

/** F20260910ctlv 彻底切换补漏：统一信号视图。
 *  数据源优先级：entries（user 信号，新真相源）→ messages（scheduler 内部系统信号，
 *  范围外决策仍写 messages）。消费面：id/senderId/senderName/body/tsp/signalMeta。 */
export interface SignalView {
  id: string;
  senderId: string;
  senderName?: string | null;
  body: string;
  /** 发言石目标（entry.yieldTargets 或 message.talkingStonePassedTo） */
  talkingStonePassedTo: string[] | null;
  /** 销账标记（entry.metadata.signalMeta 或 message.signalMeta） */
  signalMeta: string | null;
  status: string;
  senderType: string;
  /** 销账写回通道（entry metadata 或 message signal_meta） */
  markConsumed: (action: "followed_up" | "steered") => Promise<void>;
}

export type RouteAction =
  | "invoked"
  | "followed_up"
  | "steered"
  | "skipped_no_target"
  | "skipped_inactive"
  | "retry_invoked";

/** F20260908rlcp：PiSessionFactory 窄接口（信号路由只需要这三个方法） */
export interface SignalRouterSessionFactory {
  /** otter 是否在热池且正在运行 */
  isRunning(otterId: string): boolean;
  /** 向运行中的 session 队列追加 followUp 消息 */
  followUp(otterId: string, text: string): boolean;
  /** 向运行中的 session 队列追加 steer（急讯）消息。
   *  方法名 steerSession（对齐 pi-session-factory 实现——原名 steer 与实现不一致，
   *  test14 实测 factory.steer is not a function 崩进程） */
  steerSession(otterId: string, text: string): boolean;
}

/** #775 S4a：routeDirectSignal 无法进行执行时抛出——携带不可路由原因 */
export class DirectChainGatedError extends Error {
  constructor(public readonly gate: "skipped_no_signal" | "skipped_inactive" | "skipped_no_target") {
    super(`调度闸门/不可路由拦截：${gate}`);
    this.name = "DirectChainGatedError";
  }
}

export class SignalRouter {
  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      queryMessage: QueryMessage;
      /** F20260910ctlv 彻底切换补漏：entries 数据源（user 信号唯一真相源） */
      entryRepo: EntryRepository;
      queryOtter: QueryOtter;
      dispatchChainEngine: DispatchChainEngine;
      invokeFn: SignalRouterInvokeFn;
      logger: Logger;
      healingRepo?: HealingEventRepository;
      /** F20260908rlcp：LRU 热池窄接口（isRunning/followUp/steerSession） */
      factory: SignalRouterSessionFactory;
    },
  ) {}

  /**
   * #775 S4a：scheduler·招聘直投通道。
   *
   * Why 不走 routeSignal：行动类 system 消息落库后可能存在扫描窗口，常规路由会产生
   * 「入口直连派发 + 路由器重复点火」的双跑面——入口必须从原点独占点火权。
   *
   * @throws DirectChainGatedError 消息缺失/目标不可路由
   */
  async routeDirectSignal(conversationId: string, messageId: string, otterId: string): Promise<"invoked"> {
    const signal = await this.loadSignalView(messageId);
    if (!signal) {
      this.deps.logger.warn("[signal-router] 直投信号消息缺失", { conversationId, messageId });
      throw new DirectChainGatedError("skipped_no_signal");
    }
    const action = await this.routeSignalForTarget(conversationId, otterId, signal);
    switch (action) {
      case "invoked":
      case "followed_up":
      case "steered":
      case "retry_invoked":
        return "invoked";
      case "skipped_inactive":
        throw new DirectChainGatedError("skipped_inactive");
      case "skipped_no_target":
        throw new DirectChainGatedError("skipped_no_target");
      default:
        throw new DirectChainGatedError("skipped_no_target");
    }
  }

  /**
   * 事件驱动路由：信号到达时路由一个目标。
   *
   * 触发时机：
   * - web sendMessage：user 消息落库后（信号 = talkingStonePassedTo 指向的每个獭）
   * - IM（飞书）：消息入库后经 AgentDispatchService 调用
   * - resume：启动补扫（崩溃窗口兜底）
   *
   * @param filter.otterId 仅路由发往该 otter 的信号（单目标场景）
   * @returns 各信号的路由结果
   */
  async routeSignals(
    conversationId: string,
    filter?: { otterId?: string; triggerMessageId?: string },
  ): Promise<Array<{ signal: SignalView; action: RouteAction }>> {
    // F20260908rlcp 整合修复（实测双触发根因）：
    // 必须只处理「本次触发的消息」——triggerMessageId 传入时只路由该消息。
    // 旧实现扫 getMessages 全部历史逐条点火：已处理的獭产出消息（tsp 指回）
    // 会被反复重燃，同一条用户消息触发 N 次 invoke（09-09 实测：说一句话大獭被点 3 次）。
    // 獭的产出消息（senderType='otter'）绝不作为路由信号源——链引擎的 hop 续跑
    // （nextTargets）已承载 yield 路由，此处再扫 = 与链引擎双跑。
    if (!filter?.triggerMessageId) {
      // F20260908rlcp：routeAllPending 已退役，无 triggerMessageId 的调用是残留路径——拒绝
      this.deps.logger.warn("[signal-router] routeSignals 无 triggerMessageId 调用（残留路径），拒绝", { conversationId });
      return [];
    }
    return this.routeTriggerMessage(conversationId, filter.triggerMessageId, filter.otterId);
  }

  /** 路由本轮触发消息（事件 A 主路径：web/IM 消息落库后） */
  private async routeTriggerMessage(
    conversationId: string,
    triggerMessageId: string,
    otterIdFilter?: string,
  ): Promise<Array<{ signal: SignalView; action: RouteAction }>> {
    const msg = await this.loadSignalView(triggerMessageId);
    if (!msg || msg.status !== "completed" || msg.senderType === "otter") return [];
    const targets = (msg.talkingStonePassedTo ?? []).filter(t => t !== "user");
    const results: Array<{ signal: SignalView; action: RouteAction }> = [];
    for (const targetId of targets) {
      if (otterIdFilter && targetId !== otterIdFilter) continue;
      results.push({ signal: msg, action: await this.routeSignalForTarget(conversationId, targetId, msg) });
    }
    // 销账：注入成功（followed_up/steered）的信号打 consumed 标记，防重燃
    for (const r of results) {
      if (r.action !== "followed_up" && r.action !== "steered") continue;
      await r.signal.markConsumed(r.action).catch(() => {});
    }
    return results;
  }

  /** 信号销账：注入成功（followUp/steer）后给消息打 consumed 标记，
   *  resume 补扫与历史扫描跳过 consumed——防重燃。写 messages.signal_meta。 */
  private async markSignalConsumed(signal: Message, action: "followed_up" | "steered"): Promise<void> {
    const meta = { ...(signal.signalMeta ? JSON.parse(signal.signalMeta) as Record<string, unknown> : {}), consumed: action, consumedAt: new Date().toISOString() };
    await this.deps.conversationRepo.updateMessageSignalMeta(signal.id, JSON.stringify(meta));
  }

  /**
   * 路由单个信号到单个目标（核心路由逻辑）。
   *
   * 决策树：
   * 1. 目标 dissolved/inactive → 跳过（防幽灵点火）
   * 2. factory.isRunning(target) = true → 默认 followUp；标急 steer
   * 3. 否则（空闲/不在池）→ invokeFn 点火（现状路径）
   * 4. followUp/steer 返回 false → 降级 invokeFn
   */
  private async routeSignalForTarget(
    conversationId: string,
    targetId: string,
    signal: SignalView,
  ): Promise<RouteAction> {
    // 1. dissolved/inactive 目标过滤
    const otter = await this.deps.queryOtter.getById(targetId).catch(() => null);
    if (!otter || otter.status !== "active") {
      this.deps.logger.info("[signal-router] 目标不在场或非 active，跳过", { targetId, status: otter?.status });
      return "skipped_inactive";
    }

    // 2. 目标是否在热池且运行中
    if (this.deps.factory.isRunning(targetId)) {
      // F20260908rlcp 实测修复：followUp/steer 注入成功后必须销账（consumed 标记）——
      // 否则 resume 补扫与历史扫描会把已注入的信号当成「待处理」再次点火（09-09 实测三句回复根因）。
      // 销账动作与注入动作同事务语义：注入成功即写 consumed，失败则不写（下次重试）。

      /** F20260910ctlv test13（搭档拍板）：用户发言默认 steer——「插话」的本质是
       *  「我现在就有新信息要你考虑」，须立即注入当前生成（steer 打断语义），
       *  而非 followUp 排队等当前轮结束（test13 实测：followUp 注入时 LLM 生成已基于
       *  旧 prompt 进行，插话成下轮残留，獭没接住）。原 isSteerSignal（signalMeta.level=URGENT）
       *  分支不可达（档位已退役无写入方）——反转为默认 steer，followUp 退役。 */
      const steered = this.deps.factory.steerSession(targetId, this.buildSteerText(signal));
      if (steered) {
        this.deps.logger.info("[signal-router] steer 注入成功", { conversationId, messageId: signal.id, targetId });
        return "steered";
      }
      // steer 返回 false = 未在池/已停流，降级 invokeFn
      this.deps.logger.info("[signal-router] steer 不可达，降级 invoke", { conversationId, messageId: signal.id, targetId });
    }

    // 3. 空闲/不在池 → invokeFn 点火
    return this.invokeTarget(conversationId, targetId, signal);
  }

  /**
   * retry 信号（手动重试路径）：过路由+点火。与 routeSignalForTarget 同路径。
   */
  async retrySignal(
    conversationId: string,
    _messageId: string,
    targetOtterId: string,
    signal: SignalView,
    _retryAttachmentIds?: string[],
  ): Promise<"retry_invoked"> {
    await this.invokeTarget(conversationId, targetOtterId, signal);
    return "retry_invoked";
  }

  /** F20260910ctlv 彻底切换补漏：按 ID 加载信号视图。
   *  优先查 entries（user 信号唯一真相源——sendUserEntry 落 yieldTargets=tsp）；
   *  查不到再回落 messages（scheduler 内部系统信号仍写 messages，范围外决策）。
   *  entry id 与 message id 无冲突（uuid 交集≈0；scheduler 锚点只在 messages 侧）。 */
  private async loadSignalView(messageId: string): Promise<SignalView | null> {
    try {
      const entry = await this.deps.entryRepo.getEntryById(messageId);
      if (entry) return this.entryToSignalView(entry);
    } catch { /* entries 查询失败降级 messages 侧 */ }
    return this.loadMessageSignalView(messageId);
  }

  /** entry → 信号视图（user 信号主路径） */
  private entryToSignalView(entry: Entry): SignalView {
    return {
      id: entry.id,
      senderId: entry.senderId ?? "",
      senderName: entry.senderName ?? null,
      body: entry.body ?? "",
      talkingStonePassedTo: entry.yieldTargets,
      signalMeta: entry.metadata?.signalMeta ?? null,
      status: entry.status ?? "completed",
      senderType: entry.senderType ?? "",
      markConsumed: async (action) => this.markEntrySignalConsumed(entry, action),
    };
  }

  /** messages 兜底信号视图（scheduler 内部系统信号，范围外决策仍写 messages） */
  private async loadMessageSignalView(messageId: string): Promise<SignalView | null> {
    try {
      const msg = await this.deps.queryMessage.getMessageById(messageId);
      if (!msg) return null;
      return {
        id: msg.id,
        senderId: msg.senderId,
        senderName: msg.senderName,
        body: msg.segments.map(seg => seg.body).join("\n"),
        talkingStonePassedTo: msg.talkingStonePassedTo,
        signalMeta: msg.signalMeta ?? null,
        status: msg.status,
        senderType: msg.senderType,
        markConsumed: async (action) => this.markSignalConsumed(msg, action),
      };
    } catch {
      return null;
    }
  }

  /** entry 信号销账：consumed 标记写 metadata.signalMeta */
  private async markEntrySignalConsumed(entry: Entry, action: "followed_up" | "steered"): Promise<void> {
    const meta = { ...(entry.metadata ?? {}), signalMeta: JSON.stringify({ consumed: action, consumedAt: new Date().toISOString() }) };
    await this.deps.entryRepo.updateEntryMetadata(entry.id, meta);
  }

  /** F20260908rlcp：信号是否已销账（consumed 标记存在=已注入成功，补扫跳过） */
  private isSignalConsumed(signal: SignalView): boolean {
    if (!signal.signalMeta) return false;
    try {
      const meta = JSON.parse(signal.signalMeta) as { consumed?: string };
      return !!meta.consumed;
    } catch {
      return false;
    }
  }

  /** 构建信号注入文本（followUp 路径：常规排队） */
  private buildSignalText(signal: SignalView): string {
    const sender = signal.senderName?.trim() || signal.senderId;
    const content = this.extractContent(signal);
    return `[${sender}] ${content}`;
  }

  /** 构建 steer 文本（急讯路径：下一思考点注入） */
  private buildSteerText(signal: SignalView): string {
    return `【急讯 msg:${signal.id}】来自 ${signal.senderName?.trim() || signal.senderId}：${this.extractContent(signal)}`;
  }

  /** 提取信号内容（SignalView.body 单字段） */
  private extractContent(signal: SignalView): string {
    return signal.body.trim();
  }

  /**
   * 点火一次 invoke（链引擎承载）。
   * fire-and-forget：入口不被 invoke 时长阻塞。
   */
  private async invokeTarget(
    conversationId: string,
    otterId: string,
    signal: SignalView,
  ): Promise<"invoked"> {
    const userMessageContent = this.buildSignalText(signal);
    // fire-and-forget
    void (async () => {
      try {
        await this.deps.dispatchChainEngine.executeChain({
          conversationId,
          userMessageContent,
          senderId: signal.senderId,
          initialTargets: [otterId],
          invokeFn: (params) => this.deps.invokeFn(params),
          triggerMessageId: signal.id,
        });
      } catch (err) {
        this.deps.logger.error("SignalRouter invoke 失败", err instanceof Error ? err : new Error(String(err)), {
          conversationId, otterId,
        });
        await this.recordHealing({
          conversationId, messageId: signal.id, otterId,
          errorType: "other", severity: "high",
          description: `信号消费失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
    return "invoked";
  }

  private async recordHealing(input: {
    conversationId: string;
    messageId: string;
    otterId: string;
    errorType: HealingErrorType;
    severity: HealingSeverity;
    description: string;
  }): Promise<void> {
    if (!this.deps.healingRepo) return;
    const event: HealingEvent = {
      id: crypto.randomUUID(),
      messageId: input.messageId,
      conversationId: input.conversationId,
      otterId: input.otterId,
      errorType: input.errorType,
      severity: input.severity,
      description: input.description,
      suggestion: "检查信号投递路径；消费失败请查 invoke 日志与消息终态",
      context: null,
      status: "open" as HealingEventStatus,
      resolution: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    await this.deps.healingRepo.create(event).catch(err => {
      this.deps.logger.warn("SignalRouter healing 落账失败", { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
