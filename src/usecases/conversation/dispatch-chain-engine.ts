import { aggregateBody } from "@entities/conversation/message";
import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import { projectAttachments } from "@entities/conversation/attachment-projection";
import type { AttachmentRef } from "@entities/conversation/attachment";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { runWithTrace, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import { randomUUID } from "node:crypto";
// F20260826mwrd C3（Part 6）：L2 安全词扫描
import { scanStopWords } from "@usecases/signal/stop-word-scanner";

export interface ChainHopResult {
  otterReply?: string;
  nextTargets: string[];
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
}

export interface InvokeFnResult {
  messageId: string;
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
      /** F20260902sgp2 S1：触发消息 ID（派发台账记账用）。首 hop 必填；
       *  缺省时 S1 仅跳过首 hop 记账并打点日志（链路行为零变化，硬约束 1）。
       *  hop 2+ 的记账用 yield 出处消息 ID（InvokeFnResult.messageId），与此参数无关。 */
      triggerMessageId?: string;
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
    },
  ): Promise<{ otterReply?: string }> {
    const { conversationId, userMessageContent, senderId, initialTargets, invokeFn, callbacks, images, triggerMessageId } = params;
    let targets = initialTargets;
    let depth = 0;
    let lastOtterReply: string | undefined;
    const maxDepth = this.deps.maxChainDepth ?? 100;
    /** F20260902sgp2 hop 取源修复：target → 链上所有 yield 出处 messageId（链级生命周期）。
     *  多源列表：A、B 同 hop 都 yield 给 C 时，C 的记账需覆盖两条触发消息（各记一条 attempt）。
     *  原 bug：Map 是 hop 局部变量，settle 回填出方法即丢——hop 2+ 记账全部静默跳过
     *  （生产观察 2026-09-02：9 pending 中 3 条假阳性源于此）。 */
    const chainSourceMessageIds = new Map<string, string[]>();

    // F20260826mwrd C3（Part 6）：L2 安全词扫描——用户原始消息命中独立成词「停下」时
    // 生成 reminder，附在每个 hop 的消息末尾（首 hop 原文扫描；不硬拦，LLM 语境确认）。
    // 扫描失败不影响主流程（退化纯 L1 prompt 检测，与现状等价）。
    let stopWordReminder: string | null = null;
    try {
      stopWordReminder = scanStopWords(userMessageContent).reminder;
    } catch { /* 扫描器异常降级为无 reminder */ }

    while (targets.length > 0 && depth < maxDepth) {
      depth++;
      const result = await this.executeOneHop({
        conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder,
        triggerMessageId: depth === 1 ? triggerMessageId : undefined,
        chainSourceMessageIds,
      });
      lastOtterReply = result.otterReply ?? lastOtterReply;
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
    /** F20260902sgp2 hop 取源修复：链级 target → yield 出处列表（跨 hop 存活，修复局部 Map 回填即丢的 bug） */
    chainSourceMessageIds?: Map<string, string[]>;
  }): Promise<ChainHopResult> {
    const { conversationId, userMessageContent, senderId, targets, invokeFn, images, stopWordReminder, triggerMessageId, chainSourceMessageIds } = params;
    const roster = await this.buildRoster(conversationId, senderId);

    const promises = targets.map(async otterId => {
      // F20260902sgp2 S1：起跑记账（§4.2）——失败仅日志，绝不阻断链路（硬约束 1）。
      // hop 取源修复：hop 2+ 从链级多源列表取全部触发消息（一条 per (msg,target) 记账）
      this.recordAttemptStart(conversationId, otterId, triggerMessageId, chainSourceMessageIds?.get(otterId));
      let messageWithContext = await this.buildMessageWithContext(
        conversationId, otterId, userMessageContent, senderId, roster
      );
      // F20260826mwrd C3：安全词 reminder 附在消息末尾——链上每个 hop 都能看到，
      // 防注意力稀释漏判（母方案 T6）。位置在末尾：靠近生成点，注意力权重最高。
      if (stopWordReminder) {
        messageWithContext += `\n\n${stopWordReminder}`;
      }

      this.deps.logger.info('发言链调用', {
        otterId,
        messageLength: messageWithContext.length,
        messagePreview: messageWithContext.substring(0, 200),
        ...(images && { imageCount: images.length }),
      });

      return invokeFn({
        otterId, conversationId,
        userMessageContent: messageWithContext,
        senderId,
        ...(images && { images }),
      });
    });

    const results = await Promise.allSettled(promises);
    // F20260902sgp2 S1：settle 记账（§4.2）——终态回写 + 链级出处回填
    // 审视建议 1：调用点再隔一层 try/catch——防方法内部 try 块之外的理论异常阻断 markBatchRead
    try {
      this.recordAttemptSettle(conversationId, targets, results, triggerMessageId, chainSourceMessageIds);
    } catch { /* 记账面异常不阻断链路（硬约束 1） */ }
    await this.markBatchRead(conversationId, results, targets);

    return this.processHopResults(results, senderId, conversationId, targets);
  }

  /** F20260902sgp2 S1：起跑记账——首 hop 用 triggerMessageId，hop 2+ 用 yield 出处
   *  （每 hop 的 targets 来自上一 hop 各自的聚合目标，出处消息不同，按 target 配对取源）。
   *  无 repo / 无 messageId 时静默跳过（S1 观察面零侵入）；失败仅日志不阻断（硬约束 1）。 */
  private recordAttemptStart(
    conversationId: string,
    target: string,
    triggerMessageId: string | undefined,
    chainSourceMessageIds: string[] | undefined,
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
          source: "chain",
          attemptStartedAt: new Date().toISOString(),
          note: null,
        });
        this.deps.logger.info('[signal-ledger] action=record', { conv: conversationId, msg: ledgerMsgId, otter: target, status: 'in_progress', source: 'chain' });
      } catch (e) {
        this.deps.logger.warn('[signal-ledger] 起跑记账失败（不影响链路）', { conversationId, messageId: ledgerMsgId, otterId: target, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** F20260902sgp2 S1：settle 记账——每个目标按起跑同源 messageId 列表记终态；
   *  fulfilled 时把产出消息追加进链级出处列表（后续 hop 记账取源）。失败仅日志不阻断。 */
  // eslint-disable-next-line complexity -- 多源记账双层循环 + 逐源 try/catch 兜底（硬约束 1：记账失败不阻断链路），拆分反而损可读性
  private recordAttemptSettle(
    conversationId: string,
    targets: string[],
    results: PromiseSettledResult<InvokeFnResult>[],
    triggerMessageId: string | undefined,
    chainSourceMessageIds: Map<string, string[]> | undefined,
  ): void {
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
      // 触发源——按 aggregatedTargets 落位，而非记在自己名下。
      // 例：worker 产出 m-work 并 yield owner → m-work 应记在 chainSource[owner]，
      // 下 hop owner 起跑时用它记账 (m-work, owner)。多源追加不去重（A、B 都 yield C 时
      // C 名下两条触发消息各记一次）；同目标重复 yield 只留最新产出（去重 + 截尾防膨胀）。
      if (r.status === "fulfilled" && chainSourceMessageIds) {
        const produced = r.value.messageId;
        const nextHops = r.value.aggregatedTargets?.filter(id => id !== "user") ?? [];
        for (const next of nextHops) {
          const list = (chainSourceMessageIds.get(next) ?? []).filter(id => id !== produced);
          list.push(produced);
          chainSourceMessageIds.set(next, list.slice(-8));
        }
      }
    }
  }

  private async processHopResults(
    results: PromiseSettledResult<InvokeFnResult>[],
    senderId: string,
    conversationId?: string,
    targets?: string[],
  ): Promise<ChainHopResult> {
    let otterReply: string | undefined;
    const nextTargets = new Set<string>();

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled") {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.deps.logger.error('发言链目标调用失败', r.reason instanceof Error ? r.reason : new Error(reason), {
          conversationId,
          otterId: targets?.[i],
        });
        continue;
      }

      const msg = await this.deps.queryMessage.getMessageById(r.value.messageId);
      if (msg?.segments.length) {
        otterReply = aggregateBody(msg.segments);
      }

      if (r.value.aggregatedTargets) {
        for (const id of r.value.aggregatedTargets) {
          nextTargets.add(id);
        }
      }
    }

    /** #474: 只滤 'user'——人类不参与链调度（web 路径 senderId 恒为 'user'，等价回声，照旧滤除）。
     *  禁止再滤 senderId：scheduler 路径（AgentDispatchService / SchedulerService / resume）的 sender
     *  是任务属主 otter，小獭 yield 回属主是设计内交棒，被滤掉即行动权悬空（石砧 8-26 实证：链在
     *  yield 大獭后正常结束，大獭永不唤醒，需用户手动接棒）。 */
    return {
      otterReply,
      nextTargets: [...nextTargets].filter(id => id !== "user"),
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
   * 消息首部分钟级新鲜时间。本段随 user message 持久化、位于历史末尾，不占缓存前缀。 */
  async buildMessageWithContext(
    conversationId: string,
    otterId: string,
    userMessageContent: string,
    senderId: string,
    roster: string,
  ): Promise<string> {
    // F20260819idnw：闲置小獭预警（增强功能，失败不影响主流程）
    // 必须在早返回路径之前计算，否则无未读消息时预警会被跳过
    let idleWarning: string | null = null;
    try {
      idleWarning = await this.buildIdleOttersWarning(conversationId, otterId);
    } catch { /* 预警失败不影响主流程 */ }

    // F20260829cach: 分钟级当前时间（Asia/Shanghai）——补偿 system prompt 日粒度锚点的新鲜度损失
    const now = new Date();
    const timeAnchor = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

    const unreadMessages = await this.deps.conversationRepo.getUnreadMessages(conversationId, otterId);
    if (unreadMessages.length === 0) {
      let result = `${roster}\n\n## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n\n## 当前任务\n${userMessageContent}`;
      if (idleWarning) result += `\n\n${idleWarning}`;
      return result;
    }
    const names = await this.resolveSenderNames(unreadMessages);
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
    const formatted = unreadMessages
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

    let result = `${roster}\n\n## 当前时间\n- ${timeAnchor}（Asia/Shanghai）\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
    if (idleWarning) {
      result += `\n\n${idleWarning}`;
    }
    return result;
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

  private async markBatchRead(
    conversationId: string,
    results: PromiseSettledResult<InvokeFnResult>[],
    targets: string[],
  ): Promise<void> {
    /** F20260803trrf: 不依赖 getActiveTurn（turn 已在 complete() 中关闭，返回 null）。
     *  用 msg.turnId 反查 turn_number；fulfilled + rejected 都推进 last_read。 */
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      let messageId: string | undefined;
      if (r.status === 'fulfilled') {
        messageId = r.value.messageId;
      } else {
        /** rejected：invokeFn 抛错（罕见，agent-invoker.invokeConversation 已 catch 大部分）。
         *  用 targets[i] 反查该 otter 最新消息（发言已 start 但 invoke 失败）。
         *  限制（review P1）：lastMsg 是该 otter 自己发的最新消息，推进到的是"自己上次发言的 turn"
         *  而非"应读的最新 turn"。精确修复需在 buildMessageWithContext 时记录注入的最新 turn，
         *  改动大且 rejected 极罕见，接受此 best-effort 语义。 */
        const lastMsg = await this.deps.queryMessage.getLastMessageBySender(conversationId, targets[i]);
        messageId = lastMsg?.id;
      }
      if (!messageId) continue;
      const msg = await this.deps.queryMessage.getMessageById(messageId);
      if (!msg) continue;
      const turn = await this.deps.conversationRepo.getTurnById(msg.turnId);
      if (!turn) continue;
      await this.deps.conversationRepo.updateLastReadTurnNumber(conversationId, msg.senderId, turn.turnNumber);

      // F20260819idnw：更新最后活跃轮次（小獭发言时）
      if (msg.senderType === 'otter') {
        await this.deps.conversationRepo.updateLastActiveTurnNumber(
          conversationId,
          msg.senderId,
          turn.turnNumber
        );
      }
    }
  }
}
