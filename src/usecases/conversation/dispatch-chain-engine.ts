import { aggregateBody } from "@entities/conversation/message";
import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import { projectAttachments } from "@entities/conversation/attachment-projection";
import type { AttachmentRef } from "@entities/conversation/attachment";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
  /* eslint-disable max-lines -- F20260904ldgr 注入降级备注后 461>450；#530 护栏 +11 行；拆文件会切断 hop 取源与记账的紧耦合内聚 */
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { runWithTrace, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { randomUUID } from "node:crypto";
// F20260826mwrd C3（Part 6）：L2 安全词扫描
import { scanStopWords } from "@usecases/signal/stop-word-scanner";

export interface ChainHopResult {
  otterReply?: string;
  nextTargets: string[];
  /** #530 护栏 steer 文案：进程级传递，下一 hop 前置注入（解决 session 已 dispose 无法 steer 的生命周期问题） */
  steerText?: string;
}

/** F20260907ylfs ②（P3a 批次 2）：单目标 hop 产出判定——护栏决策单点化的载体。
 *  settle 记账（chainSource 回填）与路由（nextTargets）共享同一实例，两处不再各滤各的。 */
export interface HopOutcome {
  /** 行级取数：产出消息行（fetchProducedMessage，含 talkingStonePassedTo 终值）；查库失败/degraded 时 null */
  producedMsg: Awaited<ReturnType<QueryMessage["getMessageById"]>> | null;
  /** 取数降级标记（#798 发现 2）：账面补「出处降级」备注用 */
  degraded: boolean;
  /** 护栏门控后的下一跳目标（已滤 'user'；self 仅护栏放行时含）——记账与路由的唯一口径 */
  allowedNext: string[];
  /** 护栏 abort（≥5 拒入）：路由清空 nextTargets 终链，settle 不得回填 chainSource */
  aborted: boolean;
  /** 护栏 steer 警示文案（totalCount=3 生成，仅一次）——进程级传递到下一 hop 前置注入 */
  steerText?: string;
}

/** 多模态 Phase 1：每轮真图上限（服务端硬限制，超出拒绝）。
 *  依据：SDK estImageChars 按图 1200 tokens 估算，实测 GLM 2048px 图 ≈5500 input tokens
 *  （差 4.6 倍），图片多时 compaction 触发严重偏晚。 */
export const MAX_IMAGES_PER_TURN = 2;

export interface ChainCallbacks {
  /** 深度耗尽时的额外处理（MC 发系统消息，ADS 仅日志） */
  onDepthExceeded?: (pendingTargets: string[], depth: number) => void | Promise<void>;
}

export interface InvokeFnParams {
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
  /** 多模态 Phase 1：当前任务消息携带的图片（ImageContent：base64 + mimeType）。
   *  每轮 ≤2 图服务端硬限制（compaction 低估 4.6 倍实测后的预算控制）；
   *  未读历史统一文本投影不按獭分叉，分叉只发生在当前任务消息。 */
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** F20260908rlcp：本批未读消息的最大 sequence_num（启动成功后推进游标用） */
  batchMaxSeq?: number;
}

export interface InvokeFnResult {
  messageId: string;
  /** @deprecated F20260904schf：链引擎已改读行级 tsp（getMessageById 的 talkingStonePassedTo），
   *  此字段为 turn 级并集（streaming 共栖污染源，#792），保留仅供观测/过渡期，新代码禁止消费。 */
  aggregatedTargets?: string[];
}

export type InvokeFn = (params: InvokeFnParams) => Promise<InvokeFnResult>;

/**
 * 发言链调度引擎。
 * 同时服务于 SSE 和非 SSE 两条路径，通过 invokeFn 注入解耦差异。
 */
export class DispatchChainEngine {
  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      queryMessage: QueryMessage;
      queryOtter: QueryOtter;
      logger: Logger;
      maxChainDepth?: number;
      settingsRepo?: SettingsRepository;
      /** F20260814mtrc：链级指标（hop 分布/触顶计数），可选 */
      metrics?: AgentMetricsPort;
      /** F20260826fpbd：搭档身份静态判定（未注入/未配置时降级动态推断） */
      partnerResolver?: PartnerResolver;
      /** F20260902sgp2 S1：派发台账（可选注入——不注入时链路行为与 sgpv 回滚基线完全一致）。
       *  记账失败仅日志不阻断（硬约束 1）。 */
      dispatchAttemptRepo?: DispatchAttemptRepo;
      /** #530 梯度护栏：abort 回调（可选——不注入时 abort 降级为纯日志）。
       *  ⚠️ 生产链路中 session 已在 finally 块 dispose，此回调恒为 no-op。
       *  链停能力实际由 processHopResults 清空 nextTargets 实现。 */
      abort?: (otterId: string) => void;
      /** #530 梯度护栏：healing 事件仓库（可选——不注入时 healing 留痕降级为纯日志）。 */
      healingRepo?: HealingEventRepository;
    },
  ) {}

  /**
   * 执行发言链。
   * @param invokeFn 注入的调用函数 — MC 传带 onSSEEvent 的版本，ADS 传不带的版本
   *
   * F20260814mtrc：整条链包在 trace scope 内（链级 traceId，所有 hop 共享）。
   */
  async executeChain(
    params: {
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      initialTargets: string[];
      invokeFn: InvokeFn;
      callbacks?: ChainCallbacks;
      /** 多模态 Phase 1：当前任务消息携带的图片（≤2 张，超出在 controller 层已拒绝） */
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      /** F20260902sgp2 S1：触发消息 ID（首 hop 记账）。缺省时跳过首 hop 记账（链路零变化）。
       *  hop 2+ 记账用 yield 出处消息 ID，与此参数无关。 */
      triggerMessageId?: string;
      /** #775：账面来源穿透（路由器点火的记账原点在路由器；不穿透则终态行恒标 'chain'，S2 观察期标签失真）。 */
      ledgerSource?: "chain" | "router" | "retry";
      /** F20260908rlcp：恢复侧 steer 去重——已消化的 msg id 从未读注入剔除 */
      excludeMessageIds?: Set<string>;
    },
  ): Promise<{ otterReply?: string }> {
    return runWithTrace({ traceId: newTraceId(), source: "chain" }, () => this.executeChainInner(params));
  }

  // eslint-disable-next-line complexity -- F20260826mwrd C3：+安全词扫描分支（退化路径，不拆分）
  private async executeChainInner(
    params: {
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      initialTargets: string[];
      invokeFn: InvokeFn;
      callbacks?: ChainCallbacks;
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      /** F20260902sgp2 S1：触发消息 ID（首 hop 记账） */
      triggerMessageId?: string;
      /** #775：台账账面来源（穿透到首 hop 记账行，缺省 'chain'） */
      ledgerSource?: "chain" | "router" | "retry";
      /** F20260908rlcp：恢复侧 steer 去重 */
      excludeMessageIds?: Set<string>;
    },
  ): Promise<{ otterReply?: string }> {
    const { conversationId, userMessageContent, senderId, initialTargets, invokeFn, callbacks, images, triggerMessageId, ledgerSource, excludeMessageIds } = params;
    let targets = initialTargets;
    let depth = 0;
    let lastOtterReply: string | undefined;
    const maxDepth = this.deps.maxChainDepth ?? 100;
    /** F20260902sgp2 hop 取源修复：target → 链上所有 yield 出处 messageId（链级生命周期）。
     *  多源：A、B 同 hop 都 yield C 时 C 各记一条。原 bug：hop 局部 Map 出方法即丢，hop2+ 记账全跳过。 */
    const chainSourceMessageIds = new Map<string, string[]>();

    // F20260826mwrd C3（Part 6）：L2 安全词扫描——用户原始消息命中独立成词「停下」时
    // 生成 reminder，附在每个 hop 的消息末尾（首 hop 原文扫描；不硬拦，LLM 语境确认）。
    // 扫描失败不影响主流程（退化纯 L1 prompt 检测，与现状等价）。
    let stopWordReminder: string | null = null;
    try {
      stopWordReminder = scanStopWords(userMessageContent).reminder;
    } catch { /* 扫描器异常降级为无 reminder */ }

    let pendingSteerText: string | undefined; // #530 护栏 steer 文案，从上一 hop 传递到下一 hop

    while (targets.length > 0 && depth < maxDepth) {
      depth++;
      const result = await this.executeOneHop({
        conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder,
        triggerMessageId: depth === 1 ? triggerMessageId : undefined,
        ledgerSource,
        chainSourceMessageIds,
        steerText: pendingSteerText, // #530 注入上一 hop 的 steer 文案
        excludeMessageIds: depth === 1 ? excludeMessageIds : undefined, // F20260908rlcp：仅首 hop 去重
      });
      lastOtterReply = result.otterReply ?? lastOtterReply;
      pendingSteerText = result.steerText; // 收集本 hop 的 steer 文案，传递到下一 hop
      targets = result.nextTargets;
    }

    try {
      this.deps.metrics?.recordChainHops(depth);
    } catch { /* F20260814mtrc：metrics 异常不影响链路主流程 */ }

    if (targets.length > 0) {
      this.deps.logger.warn('发言链达到深度上限', { depth, targets, conversationId });
      try {
        this.deps.metrics?.recordChainDepthExceeded();
      } catch { /* F20260814mtrc */ }
      await callbacks?.onDepthExceeded?.(targets, depth);
    }

    return { otterReply: lastOtterReply };
  }

  private async executeOneHop(params: {
    conversationId: string;
    userMessageContent: string;
    senderId: string;
    targets: string[];
    invokeFn: InvokeFn;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    /** F20260826mwrd C3：「停下」等安全词 reminder（与链上下文同生命周期，随 params 传入） */
    stopWordReminder?: string | null;
    /** F20260902sgp2 S1：触发消息 ID（仅首 hop 传入；hop 2+ 的记账用 yield 出处 messageId） */
    triggerMessageId?: string;
    /** #775：台账账面来源（穿透到记账行；缺省 'chain'——S2 标签失真修复） */
    ledgerSource?: "chain" | "router" | "retry";
    /** F20260902sgp2 hop 取源修复：链级 target → yield 出处列表（跨 hop 存活，修复局部 Map 回填即丢的 bug） */
    chainSourceMessageIds?: Map<string, string[]>;
    /** #530 护栏 steer 文案：从上一 hop 传递，前置注入到本 hop 消息上下文（解决 session 已 dispose 的生命周期问题） */
    steerText?: string;
    /** F20260908rlcp：恢复侧 steer 去重——已消化的 msg id 从未读注入剔除 */
    excludeMessageIds?: Set<string>;
  }): Promise<ChainHopResult> {
    const { conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder, triggerMessageId: _triggerMessageId, ledgerSource: _ledgerSource, chainSourceMessageIds: _chainSourceMessageIds, steerText } = params;
    const roster = await this.buildRoster(conversationId, senderId);

    const promises = targets.map(async otterId => {
      // F20260908rlcp：台账退役——起跑记账删除
      const messageWithContext = await this.buildMessageWithContext(
        conversationId, otterId, userMessageContent, senderId, roster, params.excludeMessageIds
      );
      // #530 护栏 steer 文案前置注入：位置在消息开头，靠近生成点，注意力权重最高。
      // 解决 session 已 dispose 无法通过 session.steer 注入的生命周期问题。
      let fullMessage = messageWithContext.message;
      if (steerText) {
        fullMessage = `${steerText}\n\n${fullMessage}`;
        this.deps.logger.info('[self-yield-guard] steer 文案已注入下一 hop 消息', { otterId, steerTextPreview: steerText.substring(0, 100) });
      }
      // F20260826mwrd C3：安全词 reminder 附在消息末尾——链上每个 hop 都能看到，
      // 防注意力稀释漏判（母方案 T6）。位置在末尾：靠近生成点，注意力权重最高。
      if (stopWordReminder) {
        fullMessage += `\n\n${stopWordReminder}`;
      }

      this.deps.logger.info('发言链调用', {
        otterId,
        messageLength: fullMessage.length,
        messagePreview: fullMessage.substring(0, 200),
        ...(images && { imageCount: images.length }),
      });

      return invokeFn({
        otterId, conversationId,
        userMessageContent: fullMessage,
        senderId,
        ...(images && { images }),
        batchMaxSeq: messageWithContext.batchMaxSeq,
      });
    });

    const results = await Promise.allSettled(promises);
    // F20260907ylfs ②（P3a 批次 2）：护栏决策单点化——settle 记账与路由共享同一门控结果。
    // 旧序：recordAttemptSettle（:314 filter 滤 self）先执行、processHopResults（:417 filter 滤 self）
    // 后执行——两处各滤各的，自→自记账通道被 :314 无条件关死（顺序依赖，快审 delta 重点）。
    // 新序：resolveHopOutcomes 先一次完成「行级取数 + 护栏门控」，产 allowedNext per target；
    // settle（chainSource 回填）与路由（nextTargets）消费同一结果，两处 filter 分叉在结构上不可能。
    // 副产品：旧实现两处各查一次 getMessageById，合一后每 hop 少一次查库。
    const outcomes = await this.resolveHopOutcomes(conversationId, targets, results);
    // F20260904ldgr（#798 发现 2）保留：降级槽位（fetchProducedMessage 查库失败）补账面备注——
    // 追加「出处降级」标记，只改 note 不改 status（反连接不变量完好）。槽位键 = 记账键。
    // F20260907ylfs ②：degraded 随 resolveHopOutcomes 预判产出，此处批量收集（拆出控行数）。
    // F20260908rlcp：台账退役——settle 记账和降级备注删除
    try {
      return await this.processHopResults(results, senderId, outcomes, conversationId, targets);
    } finally {
      // no-op
    }
  }

  /** F20260907ylfs ②：降级槽位批量收集（自 executeOneHop 拆出，控 max-lines/complexity）。
   *  F20260904ldgr 语义不变：fetchProducedMessage 查库失败的目标 → 账面补「出处降级」备注。 */
  private collectDegradedSlots(outcomes: Map<number, HopOutcome>, targets: string[]): Array<{ target: string }> {
    const slots: Array<{ target: string }> = [];
    for (const [i, oc] of outcomes) {
      if (oc.degraded && targets[i]) slots.push({ target: targets[i] });
    }
    return slots;
  }

  /** F20260907ylfs ②：降级槽位补账面备注（自 executeOneHop 的 finally 拆出，控 max-lines）。
   *  #798 发现 2 语义不变：槽位键 = 记账键（triggerMessageId 或 chainSource[target]）。 */
  private appendDegradedNotes(
    degradedSlots: Array<{ target: string }>,
    triggerMessageId: string | undefined,
    chainSourceMessageIds: Map<string, string[]> | undefined,
  ): void {
    for (const slot of degradedSlots) {
      const ledgerMsgIds = triggerMessageId ? [triggerMessageId] : (chainSourceMessageIds?.get(slot.target) ?? []);
      for (const ledgerMsgId of ledgerMsgIds) {
        try {
          this.deps.dispatchAttemptRepo?.appendNote(ledgerMsgId, slot.target, '出处降级：invoke 完成但行级出处查库失败，yield 路由信息丢失（#798）');
        } catch { /* 备注失败不影响链路（硬约束 1） */ }
      }
    }
  }

  /** F20260907ylfs ②（P3a 批次 2）：护栏决策单点化——本 hop 全部 fulfilled 目标的产出判定。
 *  一次完成「行级取数（fetchProducedMessage）+ 护栏门控（checkSelfYieldGuardrail）」，
 *  产出 per-target 的 allowedNext（已滤 'user'；self 仅护栏放行时含）。
 *  消费方：recordAttemptSettle（chainSource 回填）与 processHopResults（nextTargets）——
 *  记账与路由共享同一结果，旧版两处独立 filter（:314/:417 各滤 self）的顺序依赖在结构上消灭。
 *  F20260904schf 保留：行级取数不变式（读产出消息自身 talkingStonePassedTo 终值，不读 turn 级并集）。
 *  查库/护栏异常降级（无出处不路由 + degraded 备注账面），不阻断链路（硬约束 1 同款纪律）。 */
  private async resolveHopOutcomes(
    conversationId: string,
    targets: string[],
    results: PromiseSettledResult<InvokeFnResult>[],
  ): Promise<Map<number, HopOutcome>> {
    const outcomes = new Map<number, HopOutcome>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const target = targets[i];
      if (r.status !== "fulfilled" || !target) continue; // rejected 目标无产出可判，不进 outcomes
      const [producedMsg, degraded] = await this.fetchProducedMessage(r.value.messageId, conversationId);
      const tsp = producedMsg?.talkingStonePassedTo ?? [];
      // F20260907ylfs ②：护栏门控（取代旧「静默滤 self → 链终止」）——门控分支下沉
      // checkSelfYieldGuardrail / filterChainTargets（各分支独立计复杂度，拆后均 < 12）。
      // self-yield = 任务锚点入箱（「任务未完，下轮继续」），消化路径唯一 = 本门控的链续跑。
      const guard = this.isSelfYield(target, conversationId, tsp)
        ? await this.checkSelfYieldGuardrail(conversationId, target, r.value.messageId)
        : { aborted: false as const, steerText: undefined };
      const allowedNext = guard.aborted ? [] : this.filterChainTargets(tsp);
      outcomes.set(i, { producedMsg, degraded, allowedNext, aborted: guard.aborted, ...(guard.steerText ? { steerText: guard.steerText } : {}) });
    }
    return outcomes;
  }

  /** F20260907ylfs ②：链调度目标过滤——'user' 恒滤（#474 人类不参与链调度）。
   *  self 不滤（护栏门控在 resolveHopOutcomes 的 guard 分支已处理）；旧版「滤 senderId」
   *  禁令见 processHopResults 的 #474 注释（scheduler 回属主交棒是设计内，不得误伤）。 */
  private filterChainTargets(tsp: string[]): string[] {
    const out: string[] = [];
    for (const id of tsp) {
      if (id !== "user") out.push(id);
    }
    return out;
  }

  /** F20260907ylfs ②（检视-840 发现 2）：self-yield 判据单点——产出消息的行级 tsp 含
   *  hop 目标自身 = 自指 yield（任务锚点入箱）。护栏门控唯一入口判据（① URGENT 注入
   *  的类似判据后续复用此处出处），conversationId 缺失（理论降级路径）时不判 self。 */
  private isSelfYield(target: string | undefined, conversationId: string | undefined, tsp: string[]): boolean {
    return !!(target && conversationId && tsp.includes(target));
  }

  /** F20260902sgp2 S1：起跑记账——首 hop 用 triggerMessageId，hop 2+ 用 yield 出处
   *  （每 hop 的 targets 来自上一 hop 各自的聚合目标，出处消息不同，按 target 配对取源）。
   *  无 repo / 无 messageId 时静默跳过（S1 观察面零侵入）；失败仅日志不阻断（硬约束 1）。 */
  private recordAttemptStart(
    conversationId: string,
    target: string,
    triggerMessageId: string | undefined,
    chainSourceMessageIds: string[] | undefined,
    ledgerSource: "chain" | "router" | "retry" = "chain",
  ): void {
    // hop 取源修复：首 hop 用 triggerMessageId；hop 2+ 用链级多源列表——
    // A、B 同 hop 都 yield 给 C 时，C 需为每条触发消息各记一条 attempt（消费义务逐条销账）
    const ledgerMsgIds = triggerMessageId ? [triggerMessageId] : (chainSourceMessageIds ?? []);
    if (ledgerMsgIds.length === 0 || !this.deps.dispatchAttemptRepo) return;
    for (const ledgerMsgId of ledgerMsgIds) {
      try {
        this.deps.dispatchAttemptRepo.recordStart({
          id: randomUUID(),
          conversationId,
          messageId: ledgerMsgId,
          targetOtterId: target,
          status: "in_progress",
          source: ledgerSource,
          attemptStartedAt: new Date().toISOString(),
          note: null,
        });
        this.deps.logger.info('[signal-ledger] action=record', { conv: conversationId, msg: ledgerMsgId, otter: target, status: 'in_progress', source: ledgerSource });
      } catch (e) {
        this.deps.logger.warn('[signal-ledger] 起跑记账失败（不影响链路）', { conversationId, messageId: ledgerMsgId, otterId: target, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** F20260902sgp2 S1：settle 记账——终态回写 + 产出消息追加进链级出处列表（hop 记账取源）。
   *  F20260904schf：出处回填改读行级 tsp（#792：aggregatedTargets turn 级并集是共栖污染源，
   *  chainSource[自己]=自己消息 → 自链循环）。行级事实依据：completeMessage 先落库后关 turn，
   *  invoke 返回时消息行已含最终 yield——行级读数因果局部，无 turn 共存窗口竞态。
   *  F20260907ylfs ②（P3a 批次 2）：出处回填改读 resolveHopOutcomes 的门控结果（本方法旧版
   *  「tsp 不含 sender 自己」领域不变量随 ② 合法化退役）——护栏放行的 self hop 记 chainSource
   *  （自→自：下轮重跑自己时对产出消息销账），拒入（≥5）不记；与路由同源，账面不说谎。 */
  // eslint-disable-next-line complexity -- 多源记账双层循环 + 逐源 try/catch 兜底（硬约束 1：记账失败不阻断链路），拆分反而损可读性
  private async recordAttemptSettle(
    params: {
      conversationId: string;
      targets: string[];
      results: PromiseSettledResult<InvokeFnResult>[];
      triggerMessageId: string | undefined;
      chainSourceMessageIds: Map<string, string[]> | undefined;
      /** F20260907ylfs ②：护栏门控后的产出判定（resolveHopOutcomes 预算）——chainSource 回填依据 */
      outcomes: Map<number, HopOutcome>;
    },
  ): Promise<void> {
    const { conversationId, targets, results, triggerMessageId, chainSourceMessageIds, outcomes } = params;
    if (!this.deps.dispatchAttemptRepo) return;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const target = targets[i];
      const ledgerMsgIds = triggerMessageId ? [triggerMessageId] : (chainSourceMessageIds?.get(target) ?? []);
      for (const ledgerMsgId of ledgerMsgIds) {
        try {
          if (r.status === "fulfilled") {
            this.deps.dispatchAttemptRepo.recordFinish(ledgerMsgId, target, "completed");
            this.deps.logger.info('[signal-ledger] action=record', { conv: conversationId, msg: ledgerMsgId, otter: target, status: 'completed', source: 'chain' });
          } else {
            const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
            this.deps.dispatchAttemptRepo.recordFinish(ledgerMsgId, target, "failed", reason.slice(0, 300));
            this.deps.logger.info('[signal-ledger] action=record', { conv: conversationId, msg: ledgerMsgId, otter: target, status: 'failed', source: 'chain', reason: reason.slice(0, 200) });
          }
        } catch (e) {
          this.deps.logger.warn('[signal-ledger] settle 记账失败（不影响链路）', { conversationId, target, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // 链级出处回填（hop 取源修复核心）：该目标的产出消息是【它 yield 给的下一跳目标】的
      // 触发源——按 resolveHopOutcomes 门控后的 allowedNext 落位（F20260907ylfs ②：护栏决策
      // 与路由同源，两处 filter 分叉在结构上不可能），而非记在自己名下。例：worker 产出 m-work
      // 并 yield owner → allowedNext=[owner]，记入 chainSource[owner]，下 hop owner 起跑时用它
      // 记账 (m-work, owner)。多源追加不去重（A、B 都 yield C 时 C 名下两条触发消息各记一次）；
      // 同目标重复 yield 只留最新产出（去重 + 截尾防膨胀）。
      if (r.status === "fulfilled" && chainSourceMessageIds) {
        const outcome = outcomes.get(i);
        if (!outcome) continue;
        const produced = r.value.messageId;
        // 护栏拒入（abort）时 allowedNext 清空是门控决策非降级，不误报污染日志——
        // 共栖污染 warn 判定下沉 warnIfCoexistPollution（F20260904schf 语义保留，拆出控语句数）
        this.warnIfCoexistPollution(outcome, r.value, conversationId, produced);
        for (const next of outcome.allowedNext) {
          this.appendChainSource(chainSourceMessageIds, next, produced, conversationId);
        }
      }
    }
  }

  /** rejected 结果日志（自 processHopResults 拆出控复杂度） */
  private logRejectedTarget(
    r: PromiseRejectedResult,
    otterId: string | undefined,
    conversationId?: string,
  ): void {
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    this.deps.logger.error('发言链目标调用失败', r.reason instanceof Error ? r.reason : new Error(reason), {
      conversationId,
      otterId,
    });
  }

  /** F20260907ylfs ②：turn 共栖污染 warn 判定（自 recordAttemptSettle 拆出，控 max-statements）。
   *  F20260904schf 语义保留：行级出处为空（且非护栏拒入——tsp 本就无目标）但聚合目标非空
   *  → turn 级并集污染被行级化拦截，warn 观测。 */
  private warnIfCoexistPollution(
    outcome: HopOutcome,
    value: InvokeFnResult,
    conversationId: string,
    produced: string,
  ): void {
    if (outcome.allowedNext.length > 0) return;
    const aggregatedNonUser = (value.aggregatedTargets?.filter(id => id !== "user").length ?? 0) > 0;
    const tspNonUser = (outcome.producedMsg?.talkingStonePassedTo ?? []).filter(id => id !== "user").length > 0;
    if (aggregatedNonUser && !tspNonUser) {
      this.deps.logger.warn('[signal-ledger] 行级出处为空但聚合目标非空（turn 共栖污染被行级化拦截）', { conv: conversationId, msg: produced, aggregated: value.aggregatedTargets });
    }
  }

  /** F20260904schf 检视发现 1（mimo-reviewer）：链级出处追加 + 截尾观测。
   *  多源追加不去重（A、B 都 yield C 时 C 名下两条触发消息各记一次）；
   *  同目标重复 yield 只留最新产出（去重 + 截尾防膨胀）。截尾丢弃更早记账源时
   *  warn（极端多源下被丢源将永远缺失消费义务销账，假 pending 风险）。
   *  F20260904ldgr（#798 发现 1 结构性修复）：截尾上限 8→16——用例支撑：单目标在途
   *  消费义务 = 并行 fan-in 上限（@提及多选，实际规模 <16）∨ 并行 invoke 池深度
   *  ∨ scheduler 群发点名数，三者取最大；16 倍于当前观测到的最大 fan-in，且仍能
   *  防无界膨胀（恶意超长 yield 链按最新 16 源保留，更早的已有 hop 记账自然消亡）。 */
  private appendChainSource(
    chainSourceMessageIds: Map<string, string[]>,
    next: string,
    produced: string,
    conversationId: string,
  ): void {
    const list = (chainSourceMessageIds.get(next) ?? []).filter(id => id !== produced);
    list.push(produced);
    const trimmed = list.slice(-16);
    if (trimmed.length < list.length) {
      this.deps.logger.warn('[signal-ledger] 链级出处列表截尾，丢弃更早记账源', { conv: conversationId, next, kept: trimmed.length, dropped: list.length - trimmed.length });
    }
    chainSourceMessageIds.set(next, trimmed);
  }

  /** F20260904schf：读产出消息行级数据（otterReply 提取 + 行级出处共用的查库点）。
   *  查库失败降级为 null（无出处不路由、无回复），不阻断链路（硬约束 1 同款纪律）；
   *  Promise.resolve 包装使 mock 返回 undefined 等非 Promise 值时仍安全。
   *  F20260904ldgr（#798 发现 2）：返回 [data, degraded]——degraded 时账面补降级备注。 */
  private async fetchProducedMessage(
    messageId: string,
    conversationId?: string,
  ): Promise<[Awaited<ReturnType<QueryMessage["getMessageById"]>> | null, boolean]> {
    try {
      const data = await Promise.resolve(this.deps.queryMessage.getMessageById(messageId));
      return [data, false];
    } catch (e) {
      this.deps.logger.warn('行级出处查库失败，降级为无出处（不阻断链路）', { conversationId, messageId, error: e instanceof Error ? e.message : String(e) });
      return [null, true];
    }
  }

  // #530 梯度护栏阈值
  private static readonly SELF_YIELD_STEER_THRESHOLD = 3;
  private static readonly SELF_YIELD_ABORT_THRESHOLD = 5;
  /** 计数扫描的消息上限——正常链路 self-yield ≤5 即触发 abort，100 足够覆盖 + 缓冲。
   *  窗口截断方向：若 95+ 条连续透明消息把介入消息挤出窗口，计数虚低（更难触发），
   *  方向上由 maxChainDepth=100 兜底，可接受。 */
  private static readonly SELF_YIELD_SCAN_LIMIT = 100;

  /** #530 梯度护栏：从消息表倒序数连续 self-yield。
   *  给定 otterId + conversationId + currentMessageId，从当前消息之前倒序扫描，遇介入即停。
   *  介入三类：①该獭自己的 to≠self yield ②user 消息 ③外部(sender≠该獭) tsp 含该獭的信号消息。
   *  不相关消息(非指向该獭的 system 消息等)透明——跳过不重置。
   *  真相源=消息表，重启不归零；同会话计数(跨会话留 P3b)。
   *  窗口截断方向：若 95+ 条连续透明消息把介入消息挤出窗口，计数虚低（更难触发），
   *  方向上由 maxChainDepth=100 兜底，可接受。 */
  // eslint-disable-next-line complexity -- #530 梯度护栏计数：6 类消息分支（self-yield/to≠self/user/system 外部信号/透明）+ try/catch
  private async countConsecutiveSelfYields(conversationId: string, otterId: string, currentMessageId: string): Promise<number> {
    try {
      // #530 修复（检视-838 发现 2）：传 before=currentMessageId 排除当前消息，避免重复计数。
      // 生产时序：completeMessage 先落库后关 turn，invoke 返回时消息行已含最终 yield——
      // 不排除会导致 count+1 虚高一档（真实阈值 2/4 ≠ 设计 3/5）。
      const messages = await this.deps.conversationRepo.getMessages(conversationId, {
        limit: DispatchChainEngine.SELF_YIELD_SCAN_LIMIT,
        before: currentMessageId,
      });
      let count = 0;
      for (const msg of messages) {
        // ① user 消息（含 retry 触发）→ 介入，停止
        if (msg.senderType === "user") break;
        // ② system 消息——检查是否为外部信号（tsp 含该獭）
        if (msg.senderType === "system") {
          if (msg.talkingStonePassedTo?.includes(otterId)) break;
          continue; // 不相关 system 透明
        }
        // otter 消息
        if (msg.senderId === otterId) {
          const tsp = msg.talkingStonePassedTo ?? [];
          if (tsp.length === 0) continue; // 无 yield = 消息没产出 yield，透明
          if (tsp.includes(otterId)) {
            count++; // 自指 yield → 计数
          } else {
            break; // to≠self yield → 介入，停止
          }
        } else {
          // 外部 otter 消息——检查 tsp 是否含该獭
          if (msg.talkingStonePassedTo?.includes(otterId)) break;
          continue; // 不相关外部消息透明
        }
      }
      return count;
    } catch (e) {
      this.deps.logger.warn('[self-yield-guard] 计数查询失败，降级为 0（不阻断链路）', {
        conversationId, otterId, error: e instanceof Error ? e.message : String(e),
      });
      return 0;
    }
  }

  /** #530 梯度护栏：自 yield 检查 + 梯度响应。
   *  检出 processHopResults 中产出消息的 tsp 含 hop 自身目标(= self-yield)时，计数并响应。
   *  返回 { aborted: true } 时 processHopResults 应清空 nextTargets 终链。
   *  返回 { steerText } 时由调用方进程级传递到下一 hop 前置注入（解决 session 已 dispose 的生命周期问题）。 */
  private async checkSelfYieldGuardrail(
    conversationId: string,
    otterId: string,
    currentMessageId: string,
  ): Promise<{ aborted: boolean; steerText?: string }> {
    const count = await this.countConsecutiveSelfYields(conversationId, otterId, currentMessageId);
    // #530 修复（检视-838 发现 2）：before=currentMessageId 排除当前消息，count = 前序 self-yield 数，
    // +1 计入当前 hop（当前消息已在 invoke 返回前落库，但 before 参数将其排除在扫描之外）
    const totalCount = count + 1;
    this.deps.logger.info('[self-yield-guard] 计数结果', { conversationId, otterId, messageId: currentMessageId, previousCount: count, totalCount });
    if (totalCount < DispatchChainEngine.SELF_YIELD_STEER_THRESHOLD) return { aborted: false };

    if (totalCount === DispatchChainEngine.SELF_YIELD_STEER_THRESHOLD) {
      // 第 3 次：steer 警示——返回 steerText 由调用方注入下一 hop（解决 session 已 dispose 的生命周期问题）
      const steerText = `[self-yield-guard] 检测到连续 ${totalCount} 次 self-yield。建议：如果任务确实较长，将中间结论交给大獭/搭档或分派出去，而非无限自续。你可以调用 speak + yield 交棒。`;
      this.deps.logger.info('[self-yield-guard] steer 警示生成，将注入下一 hop', { otterId, totalCount });
      return { aborted: false, steerText };
    }

    if (totalCount >= DispatchChainEngine.SELF_YIELD_ABORT_THRESHOLD) {
      // 第 5 次：abort + healing 留痕
      this.deps.logger.warn('[self-yield-guard] 达到 abort 阈值，强制中断链', { otterId, totalCount, conversationId });
      // healing 留痕
      try {
        await this.deps.healingRepo?.create({
          id: randomUUID(),
          messageId: currentMessageId,
          conversationId,
          otterId,
          errorType: "other",
          severity: "medium",
          description: `#530 self-yield guardrail: 连续 ${totalCount} 次 self-yield 触发 abort（链停非惩罚，可被外部重新 invoke）`,
          suggestion: "检查 otter 是否陷入自 yield 循环；任务确实较长时建议拆分或交棒",
          context: { layer: "chain-engine", selfYieldCount: totalCount },
          status: "open",
          resolution: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
      } catch (e) {
        this.deps.logger.warn('[self-yield-guard] healing 事件写入失败（不阻断 abort）', { otterId, error: e instanceof Error ? e.message : String(e) });
      }
      // abort 链
      try {
        this.deps.abort?.(otterId);
      } catch (e) {
        this.deps.logger.warn('[self-yield-guard] abort 调用异常', { otterId, error: e instanceof Error ? e.message : String(e) });
      }
      return { aborted: true };
    }

    // 4 次：只日志，不 steer（steer 只在 3 次时触发一次）
    this.deps.logger.info('[self-yield-guard] 连续 self-yield 介于 steer 和 abort 之间', { otterId, totalCount });
    return { aborted: false };
  }

  // F20260907ylfs ②：complexity 抑制随旧版自指守卫/护栏挂载逻辑投递 outcomes 而退役——现仅消费预判结果
  private async processHopResults(
    results: PromiseSettledResult<InvokeFnResult>[],
    senderId: string,
    /** F20260907ylfs ②（P3a 批次 2）：护栏门控后的产出判定（resolveHopOutcomes 预算）——
 *    本方法降为纯消费：otterReply 提取 + nextTargets 汇总 + abort/steer 聚合，不再自取数/自滤。 */
    outcomes: Map<number, HopOutcome>,
    conversationId?: string,
    targets?: string[],
  ): Promise<ChainHopResult> {
    let otterReply: string | undefined;
    const nextTargets = new Set<string>();
    let shouldAbort = false;
    let steerText: string | undefined; // #530 护栏 steer 文案，进程级传递到下一 hop

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled") {
        this.logRejectedTarget(r, targets?.[i], conversationId);
        continue;
      }

      const outcome = outcomes.get(i);
      if (!outcome) continue; // resolveHopOutcomes 跳过（无 target 等降级）——无产出可路由
      const { producedMsg, allowedNext, aborted, steerText: hopSteerText } = outcome;
      if (producedMsg?.segments.length) {
        otterReply = aggregateBody(producedMsg.segments);
      }

      // F20260907ylfs ②（P3a 批次 2）：旧版「自指守卫（行级 tsp 不含 sender 自己，滤 self → 链终止）」
      // 的领域不变量随 ② 合法化退役——self-yield 不再滤除，由 resolveHopOutcomes 护栏门控
      // （<5 放行进 nextTargets = 链续跑即消化；≥5 拒入 + abort + healing，③ 梯度护栏）接管。
      // #530：任一目标 abort 即终链（abort 后立即退出循环，不处理后续 targets）。
      if (aborted) {
        shouldAbort = true;
        break;
      }
      if (hopSteerText) {
        steerText = hopSteerText; // 收集 steer 文案，传递到下一 hop 注入
      }
      for (const id of allowedNext) {
        nextTargets.add(id);
      }
    }

    /** #474: 只滤 'user'——人类不参与链调度（web 路径 senderId 恒为 'user'，等价回声，照旧滤除）。
     *  禁止再滤 senderId：scheduler 路径（AgentDispatchService / SchedulerService / resume）的 sender
     *  是任务属主 otter，小獭 yield 回属主是设计内交棒，被滤掉即行动权悬空（石砧 8-26 实证：链在
     *  yield 大獭后正常结束，大獭永不唤醒，需用户手动接棒）。
     *  F20260907ylfs ②（检视-840 发现 1）：'user' 过滤已在 resolveHopOutcomes → filterChainTargets
     *  单点执行（allowedNext 入队前），此处不再重复 filter（每目标已过一遍，再滤是冗余动作）；
     *  self 目标不滤——护栏放行即链续跑（合法消化路径），allowedNext 已含门控结果。 */
    // #530 梯度护栏：abort 后清空 nextTargets 终链（链停非惩罚，可被外部重新 invoke）
    return {
      otterReply,
      nextTargets: shouldAbort ? [] : [...nextTargets],
      steerText, // #530 进程级传递，下一 hop 前置注入
    };
  }

  /** 在场成员名册：name 映射注入，speak 决策时免费在场（F20260803trrf: 去 otterId，speak 改用名字）
   *  F20260826fpbd：senderId 透传——飞书非搭档触发时追加访客提示，海獭知道「当前说话者不是我的搭档」 */
  async buildRoster(conversationId: string, senderId?: string): Promise<string> {
    const participants = await this.deps.conversationRepo.getActiveParticipants(conversationId);
    const lines = await Promise.all(participants.map(async p => {
      const otter = await this.deps.queryOtter.getById(p.otterId);
      return `- ${otter?.name ?? p.otterId}`;
    }));
    const partnerLabel = this.deps.settingsRepo ? ((await this.deps.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    lines.push(`- ${partnerLabel}（传 'user' 即交还行动权给搭档）`);
    // F20260826fpbd：静态绑定后，非搭档的飞书发言者（访客）触发时明示身份——
    // 避免海獭把「当前说话的人」误当成搭档（动态推断时代的田病）
    if (senderId && this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(senderId)) {
      lines.push('');
      lines.push(`## 当前说话者\n非你的搭档（访客，飞书 open_id: ${senderId}）；你的搭档是 ${partnerLabel}`);
    }
    return `## 在场成员\n${lines.join('\n')}`;
  }

  /** F20260819idnw：构建闲置小獭预警信息 */
  async buildIdleOttersWarning(
    conversationId: string,
    currentOtterId: string
  ): Promise<string | null> {
    // 从 settings 读取阈值，fallback 到默认值 20
    let threshold = 20;
    if (this.deps.settingsRepo) {
      const raw = (await this.deps.settingsRepo.get('otter_idle_threshold'))?.trim();
      if (raw) {
        const parsed = parseInt(raw, 10);
        threshold = isNaN(parsed) ? 20 : parsed;
      }
    }

    const participants = await this.deps.conversationRepo.getActiveParticipants(conversationId);
    // 使用 getMaxTurnNumber 替代 getActiveTurn，避免链式调用中 turn 已关闭的问题
    const currentTurnNumber = await this.deps.conversationRepo.getMaxTurnNumber(conversationId);

    if (!currentTurnNumber) return null;

    // 批量预取所有 participant 的 otter 信息，避免 N+1 查询
    const otterNames = new Map<string, string>();
    await Promise.all(participants.map(async p => {
      const otter = await this.deps.queryOtter.getById(p.otterId);
      if (otter) otterNames.set(p.otterId, otter.name);
    }));

    const idleOtters: Array<{ name: string; idleTurns: number }> = [];

    for (const p of participants) {
      if (p.otterId === currentOtterId) continue;
      const idleTurns = currentTurnNumber - p.lastActiveTurnNumber;
      if (idleTurns > threshold) {
        const name = otterNames.get(p.otterId);
        if (name) {
          idleOtters.push({ name, idleTurns });
        }
      }
    }

    if (idleOtters.length === 0) return null;

    const warnings = idleOtters.map(o =>
      `${o.name} 已闲置 ${o.idleTurns} 轮`
    ).join('、');

    return `系统提示：现场有小獭（${warnings}），你评估下是否顺手解散。`;
  }

  /** 组装派发上下文：名册 + 具名对话历史 + 当前任务
   * F20260829cach: 首部注入分钟级当前时间。原分钟级时间戳在 system prompt 身份段（每 invoke
   * 重建即变，打断前缀缓存）；改为：system prompt 日粒度锚点（identity-builder）+ 本处
   * 消息首部分钟级新鲜时间。本段随 user message 持久化、位于历史末尾，不占缓存前缀。
   * F20260908rlcp: 返回 batchMaxSeq（本批未读最大 seq），启动成功后推进游标。
   * @param excludeMessageIds 恢复侧 steer 去重：已消化的 msg id 从未读注入剔除 */
  // eslint-disable-next-line max-params, complexity -- F20260908rlcp: excludeMessageIds 参数 + batchMaxSeq 计算
  async buildMessageWithContext(
    conversationId: string,
    otterId: string,
    userMessageContent: string,
    senderId: string,
    roster: string,
    excludeMessageIds?: Set<string>,
  ): Promise<{ message: string; batchMaxSeq: number }> {
    // F20260819idnw：闲置小獭预警（增强功能，失败不影响主流程）
    // 必须在早返回路径之前计算，否则无未读消息时预警会被跳过
    let idleWarning: string | null = null;
    try {
      idleWarning = await this.buildIdleOttersWarning(conversationId, otterId);
    } catch { /* 预警失败不影响主流程 */ }

    // F20260829cach: 分钟级当前时间（Asia/Shanghai）——补偿 system prompt 日粒度锚点的新鲜度损失
    const now = new Date();
    const timeAnchor = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

    // K2 收件箱预告（F20260903k23）：本獭名下还有 N 条待消化信号（台账 pending 推导，
    // 排除本轮触发消息自身）。让獭能主动告知用户「我看到你插了话，跑完就处理」
    // （flash 提案缺口 1）。失败不影响主流程；本轮正在记账的信号不算在内（它就是本任务）。
    // 注：本方法自身无 messageId 参数——路由器/调度器点火路径的触发消息由调用侧语境确定，
    // 这里统一排除规则：buildMessageWithContext 不知道本轮消息时退化为「全量 pending 计数」，
    // 而本轮信号经 recordStart 已写入 in_progress 行，pendingClause 的 NOT EXISTS 天然排除它。
    const pendingPreview = this.buildPendingPreview(conversationId, otterId);

    const unreadMessages = await this.deps.conversationRepo.getUnreadMessages(conversationId, otterId);
    // F20260908rlcp：恢复侧 steer 去重——已消化的 msg id 剔除
    const filtered = excludeMessageIds ? unreadMessages.filter(m => !excludeMessageIds.has(m.id)) : unreadMessages;
    // F20260908rlcp：记录本批未读最大 seq（启动成功后推进游标）
    const batchMaxSeq = filtered.length > 0 ? Math.max(...filtered.map(m => m.sequenceNum)) : 0;
    if (filtered.length === 0) {
      let result = `${roster}\n\n## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n${pendingPreview ?? ""}\n\n## 当前任务\n${userMessageContent}`;
      if (idleWarning) result += `\n\n${idleWarning}`;
      return { message: result, batchMaxSeq };
    }
    const names = await this.resolveSenderNames(filtered);
    const partnerLabel = this.deps.settingsRepo ? ((await this.deps.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    // F20260826fuid：user 消息优先用持久化快照名（飞书群聊多人识别）。
    // F20260826fpbd：搭档判定改静态——partnerLabel 只属于配置锚定的搭档（含 Web 'user'），
    //  非搭档即使触发本次派发也不再显示 partnerLabel（动态推断时代的冒名旧病）。
    //  降级：未配置 partnerOpenId 时回退 #488 行为（当前 sender 无快照→partnerLabel）
    const resolver = this.deps.partnerResolver;
    // #497：用三元式收窄替代旧 staticMode + resolver! 断言——configured 时绑定非空 resolver 本身，
    //  TS 控制流在回调内自动收窄（if (staticResolver) ⟹ 非空），零非空断言且不把 ?. 分支点
    //  携入 .map 回调（复杂度门禁 12，携入会 13 超限）
    const staticResolver = resolver?.configured ? resolver : undefined;
    const formatted = filtered
      .map(m => {
        let label: string;
        if (m.senderType === 'system') {
          label = '系统';
        } else if (m.senderType === 'user') {
          if (staticResolver) {
            label = staticResolver.isPartner(m.senderId)
              ? partnerLabel
              : (m.senderName?.trim() || m.senderId);  // 访客：快照名，无则裸 ID 不冒充
          } else {
            // 降级（未配置 partnerOpenId）：维持 #488 行为
            label = m.senderName?.trim()
              || (m.senderId === senderId ? partnerLabel : m.senderId);
          }
        } else {
          label = (names.get(m.senderId) ?? m.senderId);
        }
        return `[${label}] ${m.segments.length ? stripHtmlCardsOnly(aggregateBody(m.segments)) : ''}${this.appendUnreadAttachmentLine(m.attachments)}`;
      })
      .join('\n');

    let result = `${roster}\n\n## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n${pendingPreview ?? ""}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
    if (idleWarning) {
      result += `\n\n${idleWarning}`;
    }
    return { message: result, batchMaxSeq };
  }

  /** K2 收件箱预告（F20260903k23）：本獭名下台账 pending 计数 > 0 时注入一行预告。
   *  数据源 = listPendingSignals（pendingClause 同一真相源）——天然含 busyQueue 排队中
   *  的信号（排队不写账 = 仍 pending），无需另查路由器内存态。
   *  本轮触发信号已被 recordStart 写入 in_progress 行，NOT EXISTS 天然排除它。
   *  HALT 在列时特别注明（用户停机请求优先级最高，獭应最先处理）。
   *  措辞纪律（#695 裁决）：只说「待消化」，不说「正在忙」/队列位置。
   *  台账未注入/查询失败 → null（纯增强，零侵入）。 */
  private buildPendingPreview(conversationId: string, otterId: string): string | null {
    if (!this.deps.dispatchAttemptRepo) return null;
    try {
      // 精确计数（#757 审视焦点 1：listPendingSignals+limit=50 会双重封顶漏报——
      // 全会话 50 条上界截断 + per-target 超 50 不诚实。count 无 limit，数字必须诚实）
      const { total, halt } = this.deps.dispatchAttemptRepo.countPendingForTarget(conversationId, otterId);
      if (total === 0) return null;
      const haltNote = halt > 0 ? `（含 ${halt} 条 HALT 停机请求，优先处理）` : "";
      return `> 收件箱预告：你名下还有 ${total} 条信号待消化${haltNote}（当前任务完成后按序处理即可）`;
    } catch {
      return null; // 预告失败不影响主流程
    }
  }

  /** 多模态 Phase 1：未读历史统一文本投影（不按目标獭分叉——last_read 保证未读皆近，
   *  历史图"知道是什么"即可；分叉只发生在当前任务消息的真图注入） */
  private appendUnreadAttachmentLine(attachments?: AttachmentRef[]): string {
    const projection = projectAttachments(attachments ?? []);
    return projection ? `\n${projection}` : "";
  }

  private async resolveSenderNames(messages: Array<{ senderType: string; senderId: string }>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const otterSenderIds = [...new Set(messages.filter(m => m.senderType === "otter").map(m => m.senderId))];
    await Promise.all(otterSenderIds.map(async id => {
      const otter = await this.deps.queryOtter.getById(id);
      if (otter) names.set(id, otter.name);
    }));
    return names;
  }

  // F20260908rlcp: markBatchRead 已删除——游标推进上移到启动成功回调（pi-session-factory）
  // 原方法职责：invoke 完成后推进 lastReadSeq + lastActiveTurnNumber
  // 新语义：prompt 启动成功即推进（推进到启动时读到的最新 seq），启动失败不推进
}
