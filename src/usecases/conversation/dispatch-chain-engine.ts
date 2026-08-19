import { aggregateBody } from "@entities/conversation/message";
import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import { USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { runWithTrace, newTraceId } from "@usecases/ports/trace-context";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";

export interface ChainHopResult {
  otterReply?: string;
  nextTargets: string[];
}

export interface ChainCallbacks {
  /** 深度耗尽时的额外处理（MC 发系统消息，ADS 仅日志） */
  onDepthExceeded?: (pendingTargets: string[], depth: number) => void | Promise<void>;
}

export interface InvokeFnParams {
  otterId: string;
  conversationId: string;
  userMessageContent: string;
  senderId: string;
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
    },
  ): Promise<{ otterReply?: string }> {
    return runWithTrace({ traceId: newTraceId(), source: "chain" }, () => this.executeChainInner(params));
  }

  private async executeChainInner(
    params: {
      conversationId: string;
      userMessageContent: string;
      senderId: string;
      initialTargets: string[];
      invokeFn: InvokeFn;
      callbacks?: ChainCallbacks;
    },
  ): Promise<{ otterReply?: string }> {
    const { conversationId, userMessageContent, senderId, initialTargets, invokeFn, callbacks } = params;
    let targets = initialTargets;
    let depth = 0;
    let lastOtterReply: string | undefined;
    const maxDepth = this.deps.maxChainDepth ?? 100;

    while (targets.length > 0 && depth < maxDepth) {
      depth++;
      const result = await this.executeOneHop(
        conversationId, userMessageContent, senderId, targets, invokeFn,
      );
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

  private async executeOneHop(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    targets: string[],
    invokeFn: InvokeFn,
  ): Promise<ChainHopResult> {
    const roster = await this.buildRoster(conversationId);

    const promises = targets.map(async otterId => {
      const messageWithContext = await this.buildMessageWithContext(
        conversationId, otterId, userMessageContent, senderId, roster
      );

      this.deps.logger.info('发言链调用', {
        otterId,
        messageLength: messageWithContext.length,
        messagePreview: messageWithContext.substring(0, 200),
      });

      return invokeFn({
        otterId, conversationId,
        userMessageContent: messageWithContext,
        senderId,
      });
    });

    const results = await Promise.allSettled(promises);
    await this.markBatchRead(conversationId, results, targets);

    return this.processHopResults(results, senderId, conversationId, targets);
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

    return {
      otterReply,
      nextTargets: [...nextTargets].filter(id => id !== senderId && id !== "user"),
    };
  }

  /** 在场成员名册：name 映射注入，speak 决策时免费在场（F20260803trrf: 去 otterId，speak 改用名字） */
  async buildRoster(conversationId: string): Promise<string> {
    const participants = await this.deps.conversationRepo.getActiveParticipants(conversationId);
    const lines = await Promise.all(participants.map(async p => {
      const otter = await this.deps.queryOtter.getById(p.otterId);
      return `- ${otter?.name ?? p.otterId}`;
    }));
    const partnerLabel = this.deps.settingsRepo ? ((await this.deps.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    lines.push(`- ${partnerLabel}（传 'user' 即交还行动权给搭档）`);
    return `## 在场成员\n${lines.join('\n')}`;
  }

  /** F20260818idnw：构建闲置小獭预警信息 */
  async buildIdleOttersWarning(
    conversationId: string,
    currentOtterId: string
  ): Promise<string | null> {
    // 从 settings 读取阈值，fallback 到默认值 20
    const threshold = this.deps.settingsRepo
      ? (await this.deps.settingsRepo.get('otter_idle_threshold'))?.trim()
        ? parseInt((await this.deps.settingsRepo.get('otter_idle_threshold'))!.trim(), 10)
        : 20
      : 20;

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

  /** 组装派发上下文：名册 + 具名对话历史 + 当前任务 */
  async buildMessageWithContext(
    conversationId: string,
    otterId: string,
    userMessageContent: string,
    senderId: string,
    roster: string,
  ): Promise<string> {
    const unreadMessages = await this.deps.conversationRepo.getUnreadMessages(conversationId, otterId);
    if (unreadMessages.length === 0) {
      return `${roster}\n\n## 当前任务\n${userMessageContent}`;
    }
    const names = await this.resolveSenderNames(unreadMessages);
    const partnerLabel = this.deps.settingsRepo ? ((await this.deps.settingsRepo.get(USER_DISPLAY_NAME_KEY))?.trim() || '搭档') : '搭档';
    const formatted = unreadMessages
      .map(m => `[${m.senderType === 'system' ? '系统' : m.senderId === senderId ? partnerLabel : (names.get(m.senderId) ?? m.senderId)}] ${m.segments.length ? stripHtmlCardsOnly(aggregateBody(m.segments)) : ''}`)
      .join('\n');

    // F20260818idnw：闲置小獭预警（增强功能，失败不影响主流程）
    let idleWarning: string | null = null;
    try {
      idleWarning = await this.buildIdleOttersWarning(conversationId, otterId);
    } catch { /* 预警失败不影响主流程 */ }
    let result = `${roster}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
    if (idleWarning) {
      result += `\n\n${idleWarning}`;
    }
    return result;
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

      // F20260818idnw：更新最后活跃轮次（小獭发言时）
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
