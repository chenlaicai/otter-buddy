import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import { projectAttachments } from "@entities/conversation/attachment-projection";
import type { AttachmentRef } from "@entities/conversation/attachment";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
  /* eslint-disable max-lines -- F20260904ldgr 注入降级备注后 461>450；#530 护栏 +11 行；拆文件会切断 hop 取源与记账的紧耦合内聚 */
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { runWithTrace, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { randomUUID } from "node:crypto";
import { DelegationInFlightError } from "@entities/errors";
// F20260826mwrd C3（Part 6）：L2 安全词扫描
import { scanStopWords } from "@usecases/signal/stop-word-scanner";
import type { SenderType } from "@entities/conversation/entry";
import { accumulateTokenUsage, emptyTokenUsage, totalTokenUsage, type TokenUsage } from "./token-usage";

export interface ChainHopResult {
  otterReply?: string;
  nextTargets: string[];
  usageDeltas?: TokenUsage[];
  /** 所有 fulfilled target 都有增量才为 true；rejected target 不纳入 telemetry 完整性。 */
  usageTelemetryComplete?: boolean;
  /** #530 护栏 steer 文案：进程级传递，下一 hop 前置注入（解决 session 已 dispose 无法 steer 的生命周期问题） */
  steerText?: string;
}

/** F20260907ylfs ②（P3a 批次 2）：单目标 hop 产出判定——护栏决策单点化的载体。
 *  settle 记账（chainSource 回填）与路由（nextTargets）共享同一实例，两处不再各滤各的。 */
export interface HopOutcome {
  /** F20260913ctlv 彻底切换：行级取数 = invoke 行（含 talkingStonePassedTo 终值）；查库失败/degraded 时 null */
  producedMsg: { id: string; status: string; otterId: string; talkingStonePassedTo: string[] | null; endedAt: string | null } | null;
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
  /** D2：委托 hop 的进程内结算标记；不落库、不路由，由持有者原链消费续轮。 */
  delegated?: boolean;
  /** 契约（F20261026ctbg 审视⑤钉扎）：实为 invoke 行 id，非 speak 消息 id——产出判定
   *  （fetchProducedMessage 读行级 tsp）与 #530 getSelfYieldDecisionEntries 的当前
   *  invoke 边界子查询均以此为前提，改动任一侧需同步。 */
  messageId: string;
  /** F20261026ctbg：本次 invoke 的四分量 token 增量，绝非 session 累计快照。 */
  tokenUsageDelta?: TokenUsage;
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
  /** F20260922ctxi：名册快照缓存（进程内纯运行时缓存，key=conversation:otter，重启自然重建）——
   *  delta 注入对比基准：内容未变不重复注入，变化时重新注入并更新快照 */
  private readonly rosterCache = new Map<string, string>();

  /** F20260922ctxi：名册段消费——返回应拼接的段（""=未变不注入；首轮/变更返回 roster + 空行） */
  private consumeRosterSegment(conversationId: string, otterId: string, roster: string): string {
    const key = `${conversationId}:${otterId}`;
    const prev = this.rosterCache.get(key);
    // 检视建议2：上限防御——key 只增不减，超限整体清空后重建当前 key（量级小，无需 LRU）
    if (this.rosterCache.size > 500) this.rosterCache.clear();
    this.rosterCache.set(key, roster);
    return prev === roster ? "" : `${roster}\n\n`;
  }

  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      queryOtter: QueryOtter;
      logger: Logger;
      settingsRepo?: SettingsRepository;
      /** F20260814mtrc：链级指标（hop 分布/触顶计数），可选 */
      metrics?: AgentMetricsPort;
      /** F20260826fpbd：搭档身份静态判定（未注入/未配置时降级动态推断） */
      partnerResolver?: PartnerResolver;
      /** #530 梯度护栏：abort 回调（可选——不注入时 abort 降级为纯日志）。
       *  ⚠️ 生产链路中 session 已在 finally 块 dispose，此回调恒为 no-op。
       *  链停能力实际由 processHopResults 清空 nextTargets 实现。 */
      abort?: (otterId: string) => void;
      /** #530 梯度护栏：healing 事件仓库（可选——不注入时 healing 留痕降级为纯日志）。 */
      healingRepo?: HealingEventRepository;
      /** F20260913ctlv 彻底切换：entries/invoke 仓库（未读注入 + hop 产出判定数据源）。
       *  未注入时（旧装配/测试桩）降级读 messages——生产装配必注入。 */
      entryRepo?: { getUnreadEntries(conversationId: string, otterId: string): Promise<Array<{ id: string; entryType: string; senderType: string | null; senderId: string | null; body: string | null; senderName: string; sequenceNum: number; invokeId: string | null; yieldTargets: string[] | null; createdAt?: string | null; attachments?: Array<{ kind: string; originalName: string }> }>>; getEntries(conversationId: string, options?: { entryType?: string; limit?: number }): Promise<Array<{ id: string; entryType: string; senderType: string | null; senderId: string | null; body: string | null; senderName: string; sequenceNum: number; invokeId: string | null; yieldTargets: string[] | null }>>; getEntryById?(id: string): Promise<{ id: string; createdAt?: string | null } | null> };
      invokeRepo?: { getInvokeById(invokeId: string): Promise<{ id: string; status: string; otterId: string; talkingStonePassedTo: string[] | null; endedAt: string | null } | null> };
      /** #530 专用决定性记录读取：透明条目不消耗有限证据窗口；旧适配器降级通用读取。 */
      selfYieldEntryRepo?: {
        getSelfYieldDecisionEntries(conversationId: string, otterId: string, currentInvokeId: string, limit: number): Promise<Array<{ id: string; entryType: string; senderId: string | null; invokeId: string | null; yieldTargets: string[] | null }>>;
      };
      /** D2：链式派工的目标忙碌判定与同 session followUp 注入。
       *  factory 与 session 保持架构边界；旧测试/装配缺省时维持直接 invoke。 */
      isRunning?: (otterId: string) => boolean;
      followUp?: (otterId: string, text: string, options?: { delegated?: boolean; conversationId?: string }) => Promise<boolean>;
      /** F20261026cnsv 审视修复（Feb 发现 1）：系统条目写入（单飞行拒绝的人话通知）。
       *  可选——未注入时通知降级为纯日志，拒绝仍由 rejected 结果通道承载。 */
      systemEntryRepo?: { createSystemEntry(input: { conversationId: string; body: string; yieldTargets?: string[]; senderName?: string }): Promise<unknown> };
      /** F20260920trrt：闲置预警新口径（seq 差 + 时间护栏）读时聚合接口。
       *  SQLite 实现已提供；测试桩可部分 mock（可选方法，未注入时预警降级为 null）。 */
      idleStatsRepo?: {
        getMaxEntrySeq(conversationId: string): number | Promise<number>;
        getLastSpeakBySender(conversationId: string): Map<string, { seq: number; createdAt: string }> | Promise<Map<string, { seq: number; createdAt: string }>>;
        getLastInvokeStartedAtByOtter(conversationId: string): Map<string, string> | Promise<Map<string, string>>;
      };
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
      /** 多模态 Phase 1：当前任务消息携带的图片（≤2 张，超出在 controller 层已拒绝） */
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      /** F20260902sgp2 S1：触发消息 ID（首 hop 记账）。缺省时跳过首 hop 记账（链路零变化）。
       *  hop 2+ 记账用 yield 出处消息 ID，与此参数无关。 */
      triggerMessageId?: string;
      /** F20261012swsg（#1430）：触发消息来源（安全词扫描闸 + 证据锚点）。只对 user 来源扫描；
       *  缺省/非 user 一律不扫描（漏报方向安全，退化纯 L1 prompt 检测）。 */
      triggerSenderType?: SenderType;
      /** F20261012swsg：触发消息序列号（证据锚点 seq 位，机械透传） */
      triggerSequenceNum?: number;
      /** F20261012swsg：触发发言人显示名（证据锚点来源细分提示——scheduler: 前缀判定；
       *  缺省回退 senderId） */
      triggerSenderName?: string | null;
      /** #775：账面来源穿透（路由器点火的记账原点在路由器；不穿透则终态行恒标 'chain'，S2 观察期标签失真）。 */
      ledgerSource?: "chain" | "router" | "retry";
      /** F20260908rlcp：恢复侧 steer 去重——已消化的 msg id 从未读注入剔除 */
      excludeMessageIds?: Set<string>;
    },
  ): Promise<{ otterReply?: string }> {
    return runWithTrace({ traceId: newTraceId(), source: "chain" }, () => this.executeChainInner(params));
  }

  /** F20261012swsg（#1430 假急停）：L2 安全词扫描闸——仅 user 来源触发消息进扫描。
   *  scheduler prompt / system 合成消息 / 重试续跑指令等非用户文本不进扫描（案发：雷达 prompt
   *  自带「停下，」被误扫注入「用户消息命中」假提醒致假急停；11:57 复现经 dispatch() 直连链同款）。
   *  失效方向：来源漏传/误标 → 不扫描 = 漏报方向，退化纯 L1（scanner 既定安全方向）。
   *  reminder 带机械证据锚点供下游核实归因。 */
  private buildStopWordReminder(input: {
    userMessageContent: string;
    senderId: string;
    triggerMessageId?: string;
    triggerSenderType?: SenderType;
    triggerSequenceNum?: number;
    triggerSenderName?: string | null;
  }): string | null {
    const { userMessageContent, senderId, triggerMessageId, triggerSenderType, triggerSequenceNum, triggerSenderName } = input;
    if (triggerSenderType !== "user") return null;
    try {
      return scanStopWords(userMessageContent, {
        messageId: triggerMessageId,
        sequenceNum: triggerSequenceNum,
        senderType: triggerSenderType,
        senderHint: triggerSenderName ?? senderId,
      }).reminder;
    } catch {
      return null; // 扫描器异常降级为无 reminder
    }
  }

  private async executeChainInner(
    params: {
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      initialTargets: string[];
      invokeFn: InvokeFn;
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
      /** F20260902sgp2 S1：触发消息 ID（首 hop 记账） */
      triggerMessageId?: string;
      /** F20261012swsg（#1430）：触发消息来源（安全词扫描闸） */
      triggerSenderType?: SenderType;
      /** F20261012swsg：触发消息序列号（证据锚点 seq 位） */
      triggerSequenceNum?: number;
      /** F20261012swsg：触发发言人显示名（证据锚点来源细分提示） */
      triggerSenderName?: string | null;
      /** #775：台账账面来源（穿透到首 hop 记账行，缺省 'chain'） */
      ledgerSource?: "chain" | "router" | "retry";
      /** F20260908rlcp：恢复侧 steer 去重 */
      excludeMessageIds?: Set<string>;
    },
  ): Promise<{ otterReply?: string }> {
    const { conversationId, userMessageContent, senderId, initialTargets, invokeFn, images, triggerMessageId, triggerSenderType, triggerSequenceNum, triggerSenderName, ledgerSource, excludeMessageIds } = params;
    let targets = initialTargets;
    let depth = 0;
    let lastOtterReply: string | undefined;
    // Why: 资源总量不能证明任务异常。只保留标量观测，不因 token、深度或回路形状终止业务链。
    const observation = { tokens: emptyTokenUsage(), telemetryGap: false, telemetryGapEmitted: false };
    /** F20260902sgp2 hop 取源修复：target → 链上所有 yield 出处 messageId（链级生命周期）。
     *  多源：A、B 同 hop 都 yield C 时 C 各记一条。原 bug：hop 局部 Map 出方法即丢，hop2+ 记账全跳过。 */
    const chainSourceMessageIds = new Map<string, string[]>();

    // F20260826mwrd C3（Part 6）：L2 安全词扫描——用户原始消息命中独立成词「停下」时
    // 生成 reminder，附在每个 hop 的消息末尾（首 hop 原文扫描；不硬拦，LLM 语境确认）。
    // 扫描失败不影响主流程（退化纯 L1 prompt 检测，与现状等价）。
    const stopWordReminder = this.buildStopWordReminder({
      userMessageContent,
      senderId,
      triggerMessageId,
      triggerSenderType,
      triggerSequenceNum,
      triggerSenderName,
    });

    let pendingSteerText: string | undefined; // #530 护栏 steer 文案，从上一 hop 传递到下一 hop

    while (targets.length > 0) {
      depth++;
      const result = await this.executeOneHop({
        conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder,
        // F20261019rpay（#1553）：triggerMessageId 透传所有 hop（原先仅首 hop）——后续 hop 反复以
        // 同一 messageId 点火时，buildMessageWithContext 靠它识别已消费旧消息的重放并打「历史」标记；
        // executeOneHop 内 excludeIds.add(triggerMessageId) 同步保证 hop≥2 不双份。
        triggerMessageId,
        ledgerSource,
        chainSourceMessageIds,
        steerText: pendingSteerText, // #530 注入上一 hop 的 steer 文案
        excludeMessageIds: depth === 1 ? excludeMessageIds : undefined, // F20260908rlcp：仅首 hop 去重
      });
      lastOtterReply = result.otterReply ?? lastOtterReply;
      pendingSteerText = result.steerText; // 收集本 hop 的 steer 文案，传递到下一 hop
      targets = result.nextTargets;
      for (const delta of result.usageDeltas ?? []) accumulateTokenUsage(observation.tokens, delta);
      // F20261026ctbg：usageTelemetryComplete=false 本身就完备刻画缺口（有 fulfilled 目标但缺 delta，
      //  含单目标 hop 过滤后数组为空的情形）——旧写法加 ?.length 前置条件会漏掉单目标缺 delta 的 hop。
      //  缺口告警/指标在检出点即时发（每链最多一次），诊断信息锚定缺口发生的位置而非链尾汇总。
      if (result.usageTelemetryComplete === false) {
        observation.telemetryGap = true;
        if (!observation.telemetryGapEmitted) {
          observation.telemetryGapEmitted = true;
          this.emitTelemetryGapWarning(conversationId, depth, observation.tokens, targets);
        }
      }
    }

    this.recordChainObservation(conversationId, depth, observation.tokens, observation.telemetryGap, targets);
    return { otterReply: lastOtterReply };
  }

  /** F20261026ctbg：链尾标量汇总（info）——深度/已知 token 总量/缺口标记/待派发目标，不判死 */
  private recordChainObservation(conversationId: string, depth: number, tokens: TokenUsage, telemetryGap: boolean, pendingTargets: string[]): void {
    const totalTokens = totalTokenUsage(tokens);
    // Why: 观测设施失败不能反向影响业务路由；缺失计量只降低可解释性，不是停止证据。
    try {
      this.deps.metrics?.recordChainHops(depth);
      this.deps.metrics?.recordChainTokenUsage(totalTokens);
    } catch { /* metrics never break dispatch */ }
    const context = { conversationId, depth, totalTokens, tokenUsage: tokens, telemetryGap, pendingTargets };
    this.deps.logger.info("发言链观测汇总", context);
  }

  /** F20261026ctbg：计量缺口检出点即时告警——每链最多一次，context 锚定缺口 hop 的位置与当时的聚合量 */
  private emitTelemetryGapWarning(conversationId: string, depth: number, tokens: TokenUsage, pendingTargets: string[]): void {
    try { this.deps.metrics?.recordChainTelemetryGap(); } catch { /* metrics never break dispatch */ }
    this.deps.logger.warn("发言链计量缺口：仅观测，不停止", { conversationId, depth, totalTokens: totalTokenUsage(tokens), tokenUsage: tokens, telemetryGap: true, pendingTargets });
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
    const { conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder, triggerMessageId, ledgerSource: _ledgerSource, chainSourceMessageIds: _chainSourceMessageIds, steerText } = params;
    const roster = await this.buildRoster(conversationId, senderId);

    // F20260922ctxi：触发消息去重——触发 entry 以 userMessageContent 形态追加发言流末尾，
    // 从未读批剔除防双份（实测同一消息 269+257 字符双份）。幂等：triggerMessageId 若非 entry id
    // （如 retry / resume 路径传的 invokeId）不会命中未读 entry 集合，自然不过滤。
    const excludeIds = new Set(params.excludeMessageIds ?? []);
    if (triggerMessageId) excludeIds.add(triggerMessageId);

    const promises = targets.map(async otterId => {
      // F20260908rlcp：台账退役——起跑记账删除
      const messageWithContext = await this.buildMessageWithContext(
        conversationId, otterId, userMessageContent, senderId, roster, excludeIds.size > 0 ? excludeIds : undefined, triggerMessageId
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

      const delegatedHop = await this.delegateBusyHop(conversationId, otterId, fullMessage);
      if (delegatedHop) return delegatedHop;

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
    // F20261026cnsv 审视修复（Feb 发现 1）：单飞行拒绝按目标粒度处理——不再整批 throw。
    // 旧序（fastFailure find→throw）会把 per-hop 拒绝放大为 per-batch + per-chain abort：
    // Promise.allSettled 已收齐的同批其他目标 fulfilled 结果（invoke 已真实执行、发言已落
    // entries）被整体丢弃，resolveHopOutcomes/processHopResults 不执行，tsp 路由与 token
    // 记账静默丢失；错误炸出 executeChain 在 message-controller 变成用户可见的「整轮调度失败」。
    // 新语义对齐 D2 定稿「新 hop 快速失败（人话）＋显式拒绝而非静默丢」：被拒目标走既有
    // rejected 结果通道（logRejectedTarget + 不进 outcomes + 不 fallback 重投，单飞行
    // 语义保留）+ 人话系统通知；兄弟目标照常 resolveHopOutcomes/processHopResults。
    await this.notifyDelegationRejections(results, targets, conversationId);
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

  /** D2：忙碌目标转 SDK 队列；仅真实 queued 才返回 delegated 进程内结果。 */
  private async delegateBusyHop(conversationId: string, otterId: string, fullMessage: string): Promise<InvokeFnResult | null> {
    if (!this.deps.isRunning?.(otterId) || !this.deps.followUp) return null;
    let delegated = false;
    try {
      delegated = await this.deps.followUp(otterId, `## 链式派工\n${fullMessage}`, { delegated: true, conversationId });
    } catch (err) {
      // 单飞行拒绝要快速失败，不能降级 invoke 再次制造并发委托。
      // F20261026cnsv 审视修复（Feb 发现 1）：「快速失败」指被拒目标不重投（下方 throw
      // 保留，该目标的 promise 以 rejected 结算）；「显式拒绝而非静默丢」由
      // notifyDelegationRejections 的 rejected 通道 + 人话系统通知承担，不再整批炸链。
      if (err instanceof DelegationInFlightError) throw err;
      this.deps.logger.warn('发言链 followUp 异常，降级直接 invoke', { conversationId, otterId, error: err instanceof Error ? err.message : String(err) });
    }
    this.deps.logger.info(delegated ? '发言链 hop 已投递（delegated）' : '发言链 followUp 未命中，降级直接 invoke', { conversationId, otterId, delegated });
    // 不建 invoke、不写持久化终态；factory 单点记录 holder healing。
    return delegated ? { messageId: '', delegated: true } : null;
  }

  /** F20261026cnsv 审视修复（Feb 发现 1）：单飞行拒绝的人话系统通知——被拒目标
   *  显式告知（对齐 D2「人话错误 + 不伪造事件流」口径），兄弟目标不受影响。
   *  healing 落账已在 factory 单飞行拒绝点完成（recordLockDegradation），此处不重复。
   *  通知失败不阻断链路（结果通道已承载拒绝，系统条目是增强可见性）。 */
  private async notifyDelegationRejections(
    results: PromiseSettledResult<InvokeFnResult>[],
    targets: string[],
    conversationId: string,
  ): Promise<void> {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== 'rejected' || !(r.reason instanceof DelegationInFlightError) || !targets[i]) continue;
      const target = targets[i];
      try {
        await this.deps.systemEntryRepo?.createSystemEntry({
          conversationId,
          body: `目标海獭（${target}）已有排队任务在消化，本次链式派工未投递（单委托防丢轮约束）；待当前任务结束后可重新派发。`,
        });
      } catch (err) {
        this.deps.logger.warn('单飞行拒绝的系统通知写入失败（不阻断链路）', { conversationId, otterId: target, error: err instanceof Error ? err.message : String(err) });
      }
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
   *  F20260908rlcp：dispatchAttemptRepo 退役——appendNote 已废弃，方法保留为空壳。 */
  private appendDegradedNotes(
    _degradedSlots: Array<{ target: string }>,
    _triggerMessageId: string | undefined,
    _chainSourceMessageIds: Map<string, string[]> | undefined,
  ): void {
    // F20260908rlcp：dispatchAttemptRepo 退役——appendNote 已废弃
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
      if (r.status !== "fulfilled" || !target || r.value.delegated) continue; // rejected/delegated 无本 hop 产出可判，不进 outcomes
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

  /** F20260902sgp2 S1：起跑记账——退役（dispatchAttemptRepo 已退役，F20260908rlcp） */

  /** F20260902sgp2 S1：settle 记账——退役（dispatchAttemptRepo 已退役，F20260908rlcp） */

  /** F20260902sgp2 S1：settle 记账——终态回写 + 产出消息追加进链级出处列表（hop 记账取源）。
   *  F20260904schf：出处回填改读行级 tsp（#792：aggregatedTargets turn 级并集是共栖污染源，
   *  chainSource[自己]=自己消息 → 自链循环）。行级事实依据：completeMessage 先落库后关 turn，
  /** F20260902sgp2 S1：settle 记账——退役（dispatchAttemptRepo 已退役，F20260908rlcp） */

  /** rejected 结果日志（自 processHopResults 拆出控复杂度） */
  private logRejectedTarget(
    r: PromiseRejectedResult,
    otterId: string | undefined,
    conversationId?: string,
  ): void {
    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
    // F20261026cnsv 审视修复（Feb 发现 1）：单飞行拒绝是背压显式拒绝而非调用失败——
    // 日志口径分开（warn 不计入 error 流），与 metrics 独立归类（delegation_rejected）一致。
    if (r.reason instanceof DelegationInFlightError) {
      this.deps.logger.warn('发言链目标被单飞行拒绝（显式拒绝，不重投）', { conversationId, otterId, reason });
      return;
    }
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
    invokeId: string,
    conversationId?: string,
  ): Promise<[{ id: string; status: string; otterId: string; talkingStonePassedTo: string[] | null; endedAt: string | null } | null, boolean]> {
    // F20260913ctlv 彻底切换：产出判定读 invokes 行（messages 停写后旧数据源只见历史）
    if (!this.deps.invokeRepo) return [null, true];
    try {
      const data = await Promise.resolve(this.deps.invokeRepo.getInvokeById(invokeId));
      return [data, false];
    } catch (e) {
      this.deps.logger.warn('行级出处查库失败，降级为无出处（不阻断链路）', { conversationId, invokeId, error: e instanceof Error ? e.message : String(e) });
      return [null, true];
    }
  }

  // #530 梯度护栏阈值
  private static readonly SELF_YIELD_STEER_THRESHOLD = 3;
  private static readonly SELF_YIELD_ABORT_THRESHOLD = 5;
  /** 旧适配器的通用读取降级；生产 SQLite 只取 4 条决定性 user/yield，不受透明噪声影响。 */
  private static readonly SELF_YIELD_SCAN_LIMIT = 100;

  /** #530 梯度护栏：从消息表倒序数连续 self-yield。
   *  给定 otterId + conversationId + currentMessageId，从当前消息之前倒序扫描，遇介入即停。
   *  介入三类：①该獭自己的 to≠self yield ②user 消息 ③外部(sender≠该獭) tsp 含该獭的信号消息。
   *  不相关消息(非指向该獭的 system 消息等)透明——跳过不重置。
   *  真相源=entry/invoke 表，重启不归零；同会话计数(跨会话留 P3b)。
   *  生产查询只读取决定性 user/yield，透明条目不会挤掉既有证据。 */
  private async countConsecutiveSelfYields(conversationId: string, otterId: string, currentInvokeId: string): Promise<number> {
    // 判定口径保持：从当前 invoke 之前倒序扫描，遇介入即停。
    // 介入三类：①该獭自己的 to≠self yield ②user entry ③外部 invoke（otter≠该獭）的 tsp 含该獭。
    try {
      const recent = this.deps.selfYieldEntryRepo
        ? await this.deps.selfYieldEntryRepo.getSelfYieldDecisionEntries(conversationId, otterId, currentInvokeId, DispatchChainEngine.SELF_YIELD_ABORT_THRESHOLD - 1)
        : await this.deps.entryRepo?.getEntries(conversationId, { limit: DispatchChainEngine.SELF_YIELD_SCAN_LIMIT });
      if (!recent) return 0;
      // getEntries 返回 DESC（最新在前）；跳过当前 invoke 自己的条目再倒序数
      let count = 0;
      let passedCurrent = false;
      for (const e of recent) {
        if (!passedCurrent) {
          if (e.invokeId === currentInvokeId || e.id === currentInvokeId) continue;
          passedCurrent = true; // 首个非当前 invoke 的条目开始计数窗口
        }
        const verdict = await this.classifyEntryForSelfYield(e, otterId);
        if (verdict === "intervene") break;
        if (verdict === "self") count++;
        // transparent：跳过不重置
      }
      return count;
    } catch (e) {
      this.deps.logger.warn('[self-yield-guard] 计数查询失败，降级为 0（不阻断链路）', {
        conversationId, otterId, error: e instanceof Error ? e.message : String(e),
      });
      return 0;
    }
  }

  /** F20260913ctlv：yield entry 是否属于该獭（senderName 无法判 id——查 invoke 行的 otterId） */
  /** #530 单条目三态分类：intervene（介入停扫）/ self（自 yield 计数）/ transparent（透明跳过） */
  private async classifyEntryForSelfYield(
    e: { entryType: string; senderId: string | null; invokeId: string | null; yieldTargets: string[] | null },
    otterId: string,
  ): Promise<"intervene" | "self" | "transparent"> {
    // ① user 条目 → 介入
    if (e.entryType === "user") return "intervene";
    if (e.entryType === "yield") {
      const tsp = e.yieldTargets ?? [];
      const own = await this.isEntryOfOtter(e, otterId);
      if (own) return tsp.includes(otterId) ? "self" : "intervene"; // 自己的 yield：self 计数 / to≠self 介入
      return tsp.includes(otterId) ? "intervene" : "transparent";   // 外部：指向该獭介入 / 透明
    }
    // invoke_end/invoke_start/speak：无 yield 信息，透明
    return "transparent";
  }

  private async isEntryOfOtter(entry: { invokeId: string | null; senderId: string | null; entryType: string }, otterId: string): Promise<boolean> {
    if (entry.senderId) return entry.senderId === otterId;
    if (!entry.invokeId || !this.deps.invokeRepo) return false;
    const invoke = await this.deps.invokeRepo.getInvokeById(entry.invokeId).catch(() => null);
    return invoke?.otterId === otterId;
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
    const nextTargets = new Set<string>();
    let shouldAbort = false;
    let steerText: string | undefined; // #530 护栏 steer 文案，进程级传递到下一 hop
    const usageDeltas: Array<TokenUsage | undefined> = [];
    // 资源计量先遍历全部 settled 结果，与下方路由 abort 解耦；并发目标即使终链也已真实消耗。
    for (const result of results) {
      if (result.status === "fulfilled" && !result.value.delegated) usageDeltas.push(result.value.tokenUsageDelta);
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled") {
        this.logRejectedTarget(r, targets?.[i], conversationId);
        continue;
      }

      const outcome = outcomes.get(i);
      if (!outcome) continue; // resolveHopOutcomes 跳过（无 target 等降级）——无产出可路由
      const { allowedNext, aborted, steerText: hopSteerText } = outcome;
      // F20260913ctlv 彻底切换：otterReply/producedMsg 从 invoke 行不可得（内容在 speak entries）——
      // 回复预览已无消费方依赖 segments；otterReply 字段退役

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
      allowedNext.forEach(id => {
        nextTargets.add(id);
      });
    }

    /** #474: 只滤 'user'——人类不参与链调度（web 路径 senderId 恒为 'user'，等价回声，照旧滤除）。
     *  禁止再滤 senderId：scheduler 路径（AgentDispatchService / SchedulerService / resume）的 sender
     *  是任务属主 otter，小獭 yield 回属主是设计内交棒，被滤掉即行动权悬空（石砧 8-26 实证：链在
     *  yield 大獭后正常结束，大獭永不唤醒，需用户手动接棒）。
     *  F20260907ylfs ②（检视-840 发现 1）：'user' 过滤已在 resolveHopOutcomes → filterChainTargets
     *  单点执行（allowedNext 入队前），此处不再重复 filter（每目标已过一遍，再滤是冗余动作）；
     *  self 目标不滤——护栏放行即链续跑（合法消化路径），allowedNext 已含门控结果。 */
    // #530 梯度护栏：abort 后清空 nextTargets 终链（链停非惩罚，可被外部重新 invoke）
    // F20261026ctbg 审视修复④：全 rejected hop（无任何 fulfilled 目标）不是计量缺口——
    // usageDeltas.length=0 在该场景语义是「无 fulfilled 可计量」，非「fulfilled 但缺报」
    const hasFulfilled = results.some(r => r.status === "fulfilled" && !r.value.delegated);
    return {
      nextTargets: shouldAbort ? [] : [...nextTargets],
      steerText, // #530 进程级传递，下一 hop 前置注入
      usageDeltas: usageDeltas.filter((usage): usage is TokenUsage => usage !== undefined),
      usageTelemetryComplete: !hasFulfilled || usageDeltas.every(usage => usage !== undefined),
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
    // 避免海獭把「当前说话的人」误当成搭档（动态推断时代的旧病）
    // F20260928wxid：渠道标注按 senderId 形态判定（微信 ilink ID 带 @im.wechat 后缀）——
    // 原硬编码「飞书 open_id」在微信访客触发时误导海獭脑补成飞书账号
    if (senderId && this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(senderId)) {
      const channelLabel = senderId.includes('@im.wechat') ? '微信' : '飞书';
      lines.push('');
      lines.push(`## 当前说话者\n非你的搭档（访客，${channelLabel} ID: ${senderId}）；你的搭档是 ${partnerLabel}`);
    }
    return `## 在场成员\n${lines.join('\n')}`;
  }

  /** F20260819idnw：构建闲置小獭预警信息 */
  /** F20260920trrt：构建闲置小獭预警信息（新口径：发言 seq 差 + 时间护栏 + 只对非 big 小獭告警）。
   *
   * 与旧版（F20260819idnw，turn 刻度）的三点差异：
   * 1. 语义换轨：闲置 = 「距该小獭上次发言以来对话又推进了 K 条发言」（entries 全类型计数）
   *    ——turn 退役后 seq 差是对话推进的唯一稳定刻度；
   * 2. 活跃信号 = speak（发言），不再用「被唤醒」：大獭刚 yield 完石子即被误报「闲置 54 轮」
   *    的乌龙不再发生；刚入场未发言的小獭按「入群后对话发言数」计，不误伤；
   * 3. 时间护栏：seq 差超阈值但 2h 内被唤醒过的小獭不告警（高频干活中），
   *    防止刚被唤醒干活的小獭因尚未发言被误报（搭档 09-18 拍板）。
   *    注：speak 时间本身不参护栏（小獭发言后又有 K 条发言才会计入差值，语义自洽）。
   *
   * 分发对象：仅 big——解散权限专属。旧版对所有被唤醒目标注入（含小獭），
   * 乌龙现场：小獭认真讨论是否解散大獭。注入点不变（buildMessageWithContext），
   * 靠本处 receiver 过滤保证只对 big 生效。 */
  async buildIdleOttersWarning(
    conversationId: string,
    currentOtterId: string,
  ): Promise<string | null> {
    // 预警只发给有解散权的大獭：非 big 直接短路
    const currentOtter = await this.deps.queryOtter.getById(currentOtterId);
    if (!currentOtter || currentOtter.type !== 'big') return null;

    // 新口径数据源（未注入时降级为无预警——增强功能，不阻断主流程）
    const stats = this.deps.idleStatsRepo;
    if (!stats) return null;

    const { seqThreshold, graceHours } = await this.readIdleThresholds();

    const maxSeq = await stats.getMaxEntrySeq(conversationId);
    if (maxSeq === 0) return null; // 对话无任何 entry（异常边界）

    const [participants, lastSpeak, lastInvoke] = await Promise.all([
      this.deps.conversationRepo.getActiveParticipants(conversationId),
      stats.getLastSpeakBySender(conversationId),
      stats.getLastInvokeStartedAtByOtter(conversationId),
    ]);

    // 批量预取 otter（type 过滤 + 名字映射）
    const otterNames = new Map<string, string>();
    const otterTypes = new Map<string, string>();
    await Promise.all(participants.map(async p => {
      const otter = await this.deps.queryOtter.getById(p.otterId);
      if (otter) {
        otterNames.set(p.otterId, otter.name);
        otterTypes.set(p.otterId, otter.type);
      }
    }));

    const now = Date.now();
    const GRACE_MS = graceHours * 3600_000;
    const idleOtters: Array<{ name: string; speakGap: number; lastSeen: string }> = [];

    for (const p of participants) {
      if (p.otterId === currentOtterId) continue;
      if (otterTypes.get(p.otterId) === 'big') continue; // 大獭互相不告警（解散对象只有小獭）
      const name = otterNames.get(p.otterId);
      if (!name) continue; // otter 记录缺失（异常边界）
      // 检视发现 9：护栏数据源扩为 max(最后被唤醒, 入场时间)——新入场未被唤醒的小獭
      // 在入场 2h 内不告警（刚进场还没派上活不是闲置）；超 2h 仍未被唤醒也未发言则
      // 报闲置是正确语义（真闲置）。
      // 复检发现 5（格式契约）：下方 max 取自字典序比较，依赖两源同为 JS ISO UTC
      // （含 Z、同长度）——invokes.startedAt（send-entry toISOString）与
      // participant.createdAt（manage-participant join toISOString）当前均满足。
      // 若未来任一写入方改格式（如 SQLite datetime('now') 无时区），须改为
      // 先 Date.parse 再比毫秒——字典序对混合格式会静默错序。
      const guardSince = [lastInvoke.get(p.otterId), p.createdAt]
        .filter((t): t is string => !!t)
        .reduce((a, b) => (a > b ? a : b), '');
      const hit = this.evaluateIdleParticipant(p.otterId, { maxSeq, lastSpeak, lastInvoke, guardSince, seqThreshold, graceMs: GRACE_MS, now });
      if (hit) idleOtters.push({ name, ...hit });
    }

    if (idleOtters.length === 0) return null;

    const warnings = idleOtters.map(o =>
      `${o.name}（距上次发言已隔 ${o.speakGap} 条消息，最近活动 ${o.lastSeen}）`
    ).join('、');

    return `系统提示：现场有小獭（${warnings}）已长时间未参与，你评估下是否顺手解散。`;
  }

  /** F20260920trrt：单只小獭闲置判定（纯函数风格，无副作用）。
 *  返回 null = 不闲置/不告警；返回 { speakGap, lastSeen } = 告警。
 *  发言 seq 差：该小獭最后一条 speak 之后对话又新增的发言数（全类型计数；
 *  未发言过的小獭 seq 记 0，差值 = 入群以来对话总发言推进，不误伤刚入场）。
 *  时间护栏：2h 内被唤醒过（invokes.started_at，JS ISO UTC 直比）不告警（搭档 09-18 拍板）；
 *  speak 时间不参护栏（小獭发言后又有 K 条发言才会计入差值，语义自洽）。 */
  private evaluateIdleParticipant(otterId: string, ctx: {
    maxSeq: number;
    lastSpeak: Map<string, { seq: number; createdAt: string }>;
    lastInvoke: Map<string, string>;
    /** 护栏起点：max(最后被唤醒, 入场时间)——空串表示两者皆无（异常边界，护栏不生效） */
    guardSince: string;
    seqThreshold: number;
    graceMs: number;
    now: number;
  }): { speakGap: number; lastSeen: string } | null {
    const lastSpeakSeq = ctx.lastSpeak.get(otterId)?.seq ?? 0;
    const speakGap = ctx.maxSeq - lastSpeakSeq;
    if (speakGap <= ctx.seqThreshold) return null;

    if (ctx.guardSince) {
      // invokes.startedAt / participant.createdAt 均为 JS ISO UTC（含 Z）——Date.parse 直比
      const guardMs = Date.parse(ctx.guardSince);
      if (!Number.isNaN(guardMs) && ctx.now - guardMs < ctx.graceMs) return null;
    }

    return { speakGap, lastSeen: ctx.guardSince || '从未被唤醒且无入场记录' };
  }

  /** F20260920trrt：闲置阈值读取——otter_idle_threshold（seq 差，默认 30）+ otter_idle_grace_hours（小时，默认 2）。
 *  旧键 otter_idle_threshold 语义自本特性起由「轮数」换轨为「发言 seq 差」（turn 退役）。 */
  private async readIdleThresholds(): Promise<{ seqThreshold: number; graceHours: number }> {
    let seqThreshold = 30;
    let graceHours = 2;
    if (this.deps.settingsRepo) {
      const rawSeq = (await this.deps.settingsRepo.get('otter_idle_threshold'))?.trim();
      if (rawSeq) {
        const parsed = parseInt(rawSeq, 10);
        seqThreshold = isNaN(parsed) ? 30 : parsed;
      }
      const rawGrace = (await this.deps.settingsRepo.get('otter_idle_grace_hours'))?.trim();
      if (rawGrace) {
        const parsedGrace = parseFloat(rawGrace);
        graceHours = isNaN(parsedGrace) ? 2 : parsedGrace;
      }
    }
    return { seqThreshold, graceHours };
  }

  /** 组装派发上下文：名册 + 单一时间序发言流（历史未读 + 触发消息流末尾）。
   *  F20260922ctxi 搭档拍板方案 A：删「## 当前任务」叙事段——一切皆发言（聊天室模型），
   *  触发发言并入流末尾（最新=天然焦点），消除「记录 vs 工单」两顶帽子的叙事割裂。
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
    triggerMessageId?: string,
  ): Promise<{ message: string; batchMaxSeq: number }> {
    // F20260819idnw：闲置小獭预警（增强功能，失败不影响主流程）
    // 必须在早返回路径之前计算，否则无未读消息时预警会被跳过
    const idleWarning = await this.buildIdleOttersWarning(conversationId, otterId).catch(() => null); /* 预警失败不影响主流程 */

    // F20260829cach: 分钟级当前时间（Asia/Shanghai）——补偿 system prompt 日粒度锚点的新鲜度损失。
    // 分钟级=每轮变化，按「有变化的才注入」原则合规，每轮注入。
    const now = new Date();
    const timeAnchor = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    // #1431 方案 B：注入行时间戳（月日时分，Asia/Shanghai）——历史消息带时间语义，
    // LLM 可区分「搭档刚说的」与「很久以前说的」（事故：86 分钟前旧话被当新授权）。
    const fmtTime = (iso?: string | null): string => {
      const t = iso == null ? now : new Date(iso);
      // 解析异常不得伪装成当前时间（历史行会变成「历史 · 当前时间」的误导形态）
      if (Number.isNaN(t.getTime())) return '时间未知';
      return t.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    };
    // #1431 方案 B：注入区解读规范——历史行（含重启恢复/历史收缩路径的重放）不得作为新授权/新裁决依据。
    const historyNote = '> 注：标注「历史」的行是本轮之前的消息（重启恢复/历史收缩路径可能重放），括号内为发言时间；旧消息不得作为新授权/新裁决依据。';

    // F20260913ctlv 彻底切换：未读注入读 entries（user/system/speak），messages 停写后旧数据源只会读到空集
    const unreadAll = this.deps.entryRepo
      ? await this.deps.entryRepo.getUnreadEntries(conversationId, otterId)
      : [];
    // F20260928wxid（检视建议 2）：触发消息 senderName 快照——从未读全集反查（入排除集前必在集内；
    // retry/resume 路径 id 非 entry id 时自然 miss，降级无快照标签）
    const triggerSenderName = (triggerMessageId ? unreadAll.find(m => m.id === triggerMessageId)?.senderName : undefined) ?? null;
    // F20260908rlcp：恢复侧 steer 去重——已消化的 entry id 剔除
    const filtered = excludeMessageIds ? unreadAll.filter(m => !excludeMessageIds.has(m.id)) : unreadAll;
    // F20260908rlcp：记录本批未读最大 seq（启动成功后推进游标；entries 序号）
    // F20261014czgd：空批语义修正——filtered 空集（典型：触发消息是唯一未读、被 triggerMessageId
    // 去重后为空，1:1 安静轮次必然命中）时 batchMaxSeq 取对话当前 max(seq) 而非 0。
    // 旧口径 batchMaxSeq=0 是「无新读」哨兵，却被 pushCursorOnStartup 当合法 seq 写入游标
    // （pi-session-factory 只挡 undefined 不挡 0、updateLastReadSeq 无单调性校验），
    // 下一轮 getUnreadEntries 按 seq>0 把全历史当未读注入（10-13 三起同型爆窗：121K/75K/304K 字符）。
    // 触发消息此刻已被消费（以 userMessageContent 形态在发言流末尾），游标本就该越过它；
    // 触发消息非 entry（retry/resume 路径）时 getMaxEntrySeq 等价「读到最新」，同样正确。
    // 取 max(filtered, unreadAll) 双保险：excludeMessageIds 剔除的可能不止触发消息。
    // F20261014czgd（检视建议 3 处置）：idleStatsRepo 缺失时降级为 0 且打 warn——
    // 根治层失效的静默降级是观测盲区（本次事故全靠推断定位），显式日志让降级可见。
    const idleMaxSeq = this.deps.idleStatsRepo?.getMaxEntrySeq
      ? await this.deps.idleStatsRepo.getMaxEntrySeq(conversationId)
      : (this.deps.logger.warn('[cursor-guard] idleStatsRepo 缺失，空批兜底退化为 0（仅剩 SQL 闸单层防线）', { conversationId, otterId }), 0);
    const batchMaxSeq = filtered.length > 0
      ? Math.max(...filtered.map(m => m.sequenceNum))
      : Math.max(
          unreadAll.length > 0 ? Math.max(...unreadAll.map(m => m.sequenceNum)) : 0,
          idleMaxSeq,
        );
    // F20260922ctxi：名册 delta 注入——内容未变（同对话同獭）时不重复拼接，仅首轮/变更时注入
    const rosterSegment = this.consumeRosterSegment(conversationId, otterId, roster);

    // F20260928wxid（检视建议 2）：partnerLabel/staticResolver 计算上移（原在非空分支）——
    // 触发消息标签两条 return 路径都要用；纯读无副作用，时机前移逻辑等价
    const partnerLabel = this.deps.settingsRepo ? ((await this.deps.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    const resolver = this.deps.partnerResolver;
    // #497：三元式收窄（staticResolver 非 undefined ⟹ resolver 非空，回调内自动收窄）
    const staticResolver = resolver?.configured ? resolver : undefined;
    // 触发消息标签与历史渲染同款规则（resolveUserEntryLabel 不用 names，无需 resolveSenderNames）
    const triggerLabel = this.resolveUserEntryLabel(
      { senderName: triggerSenderName }, senderId, senderId, partnerLabel, staticResolver,
    );

    // F20261019rpay（#1553）：触发消息时间戳 + 重放标记。触发消息若为已消费旧消息的重放（不在本轮
    // 未读批、却是真实 entry），必须带「历史」标记并用其真实 createdAt，而非本轮时刻 fmtTime()——
    // 否则 30 分钟前的旧话会被 LLM 当「刚发的新消息」当新指令处理（#1553，与 #1431 同型）。
    // 非 entry 触发（retry/resume 传 invokeId，getEntryById 为 null）保持原新鲜呈现。
    const { createdAt: triggerCreatedAt, isReplay: triggerIsReplay } = await this.resolveTriggerPresentation(unreadAll, triggerMessageId);
    const triggerTimeStr = triggerIsReplay ? `历史 · ${fmtTime(triggerCreatedAt)}` : fmtTime(triggerCreatedAt);

    if (filtered.length === 0) {
      const result = `${rosterSegment}## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n\n## 对话历史（你上次发言后的消息）\n${historyNote}\n[${triggerLabel}]（${triggerTimeStr}）${userMessageContent}${idleWarning ? `\n\n${idleWarning}` : ''}`;
      return { message: result, batchMaxSeq };
    }
    const names = await this.resolveSenderNames(filtered);
    // F20260826fuid：user 消息优先用持久化快照名（飞书群聊多人识别）。
    // F20260826fpbd：搭档判定改静态——partnerLabel 只属于配置锚定的搭档（含 Web 'user'），
    //  非搭档即使触发本次派发也不再显示 partnerLabel（动态推断时代的冒名旧病）。
    //  降级：未配置 partnerOpenId 时回退 #488 行为（当前 sender 无快照→partnerLabel）
    // F20260928wxid：resolver/staticResolver 已上移（触发消息标签共用）；formatEntry 消费同名变量
    const formatEntry = (m: typeof filtered[number]): string => {
      const label = this.resolveUnreadSenderLabel(m, senderId, partnerLabel, staticResolver, names);
      const text = stripHtmlCardsOnly(m.body ?? '');
      return `[${label}]（历史 · ${m.createdAt == null ? '时间未知' : fmtTime(m.createdAt)}）${text}${this.appendUnreadAttachmentLine(m.attachments as AttachmentRef[] | undefined)}`;
    };
    const formatted = filtered.map(formatEntry).join('\n');

    // F20260928wxid（检视建议 2）：触发消息带发送者标签（triggerLabel 已在前置段计算）——
    // 原本读批剔除后裸文追加，一问一答流（窗口唯一消息即触发消息）称呼不进海獭视野
    const result = `${rosterSegment}## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n\n## 对话历史（你上次发言后的消息）\n${historyNote}\n${formatted}\n\n[${triggerLabel}]（${triggerTimeStr}）${userMessageContent}${idleWarning ? `\n\n${idleWarning}` : ''}`;
    return { message: result, batchMaxSeq };
  }

  /** F20261019rpay（#1553）：触发消息「新鲜 vs 重放」判定 + 真实 createdAt。
   *  重放 = 真实 entry 但不在本轮未读批（已被消费、派发链后续 hop 重复以同一 messageId 点火）。
   *  双信号判定（unreadAll 命中 + getEntryById），非时间阈值启发式。 */
  private async resolveTriggerPresentation(
    unreadAll: Array<{ id: string; createdAt?: string | null }>,
    triggerMessageId?: string,
  ): Promise<{ createdAt: string | null; isReplay: boolean }> {
    if (!triggerMessageId) return { createdAt: null, isReplay: false };
    const inUnread = unreadAll.find(m => m.id === triggerMessageId);
    if (inUnread) return { createdAt: inUnread.createdAt ?? null, isReplay: false };
    if (this.deps.entryRepo?.getEntryById) {
      const entry = await this.deps.entryRepo.getEntryById(triggerMessageId);
      if (entry) return { createdAt: entry.createdAt ?? null, isReplay: true };
    }
    return { createdAt: null, isReplay: false };
  }

  /** buildPendingPreview 已退役（F20260908rlcp：台账退役后数据源不存在） */

  /** 多模态 Phase 1：未读历史统一文本投影（不按目标獭分叉——last_read 保证未读皆近，
   *  历史图"知道是什么"即可；分叉只发生在当前任务消息的真图注入） */
  private appendUnreadAttachmentLine(attachments?: AttachmentRef[]): string {
    const projection = projectAttachments(attachments ?? []);
    return projection ? `\n${projection}` : "";
  }

  /** 未读条目发送者标签（system/otter/user 三态；user 走 partner 静态绑定 + 快照名降级） */
  private resolveUnreadSenderLabel(
    m: { senderType: string | null; senderId: string | null; senderName?: string | null; entryType: string },
    senderId: string,
    partnerLabel: string,
    staticResolver: { isPartner: (id: string) => boolean } | undefined,
    names: Map<string, string>,
  ): string {
    const entrySenderId = m.senderId ?? '';
    if (m.senderType === 'system' || m.entryType === 'system') return '系统';
    if (m.senderType === 'user' || m.entryType === 'user') {
      return this.resolveUserEntryLabel(m, entrySenderId, senderId, partnerLabel, staticResolver);
    }
    return names.get(entrySenderId) ?? entrySenderId;
  }

  /** user 条目标签：静态绑定（搭档/访客快照名/裸 ID）或未配置降级（#488 行为）。
   *  F20260928wxid（检视发现 2a）：搭档标签带自报快照名——partnerLabel（默认「搭档」/全局设置）
   *  是配置层的泛称，快照名是用户自报的真名；有快照优先真名，无则回退 partnerLabel 不变 */
  private resolveUserEntryLabel(
    m: { senderName?: string | null },
    entrySenderId: string,
    senderId: string,
    partnerLabel: string,
    staticResolver: { isPartner: (id: string) => boolean } | undefined,
  ): string {
    if (staticResolver) {
      if (staticResolver.isPartner(entrySenderId)) {
        const sn = m.senderName?.trim();
        return sn ? `${partnerLabel}(${sn})` : partnerLabel; // 真交付：自报称呼进海獭视野，泛称不变
      }
      return m.senderName?.trim() || entrySenderId;  // 访客：快照名，无则裸 ID 不冒充
    }
    // 降级（未配置 partnerOpenId）：维持 #488 行为——当前 sender 无快照 → partnerLabel，
    // 其他人无快照 → 裸 ID（不冒充搭档）
    return m.senderName?.trim() || (entrySenderId === senderId ? partnerLabel : entrySenderId);
  }

  private async resolveSenderNames(messages: Array<{ senderType: string | null; senderId: string | null }>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const otterSenderIds = [...new Set(messages.filter(m => (m.senderType ?? "") === "otter").map(m => m.senderId ?? ""))];
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
