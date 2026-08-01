import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import type { SendMessage } from "./send-message";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";

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
      sendMessage: SendMessage;
      queryMessage: QueryMessage;
      queryOtter: QueryOtter;
      logger: Logger;
      maxChainDepth?: number;
    },
  ) {}

  /**
   * 执行发言链。
   * @param invokeFn 注入的调用函数 — MC 传带 onSSEEvent 的版本，ADS 传不带的版本
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
    const { conversationId, userMessageContent, senderId, initialTargets, invokeFn, callbacks } = params;
    let targets = initialTargets;
    let depth = 0;
    let lastOtterReply: string | undefined;
    const maxDepth = this.deps.maxChainDepth ?? 20;

    while (targets.length > 0 && depth < maxDepth) {
      depth++;
      const result = await this.executeOneHop(
        conversationId, userMessageContent, senderId, targets, invokeFn,
      );
      lastOtterReply = result.otterReply ?? lastOtterReply;
      targets = result.nextTargets;
    }

    if (targets.length > 0) {
      this.deps.logger.warn('发言链达到深度上限', { depth, targets, conversationId });
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
    await this.markBatchRead(conversationId, results);

    return this.processHopResults(results, senderId);
  }

  private async processHopResults(
    results: PromiseSettledResult<InvokeFnResult>[],
    senderId: string,
  ): Promise<ChainHopResult> {
    let otterReply: string | undefined;
    const nextTargets = new Set<string>();

    for (const r of results) {
      if (r.status !== "fulfilled") continue;

      const msg = await this.deps.queryMessage.getMessageById(r.value.messageId);
      if (msg?.body) {
        otterReply = msg.body;
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

  /** 在场成员名册：name ↔ otterId 映射确定性注入，speak 决策时免费在场 */
  async buildRoster(conversationId: string): Promise<string> {
    const participants = await this.deps.sendMessage.repo.getActiveParticipants(conversationId);
    const lines = await Promise.all(participants.map(async p => {
      const otter = await this.deps.queryOtter.getById(p.otterId);
      return `- ${otter?.name ?? p.otterId} (otterId: ${p.otterId})`;
    }));
    lines.push(`- 搭档（传 'user' 即交还发言权）`);
    return `## 在场成员\n${lines.join('\n')}`;
  }

  /** 组装派发上下文：名册 + 具名对话历史 + 当前任务 */
  async buildMessageWithContext(
    conversationId: string,
    otterId: string,
    userMessageContent: string,
    senderId: string,
    roster: string,
  ): Promise<string> {
    const unreadMessages = await this.deps.sendMessage.repo.getUnreadMessages(conversationId, otterId);
    if (unreadMessages.length === 0) {
      return `${roster}\n\n## 当前任务\n${userMessageContent}`;
    }
    const names = await this.resolveSenderNames(unreadMessages);
    const formatted = unreadMessages
      .map(m => `[${m.senderType === 'system' ? '系统' : m.senderId === senderId ? '搭档' : (names.get(m.senderId) ?? m.senderId)}] ${m.body ? stripHtmlCardsOnly(m.body) : ''}`)
      .join('\n');
    return `${roster}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
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
  ): Promise<void> {
    const currentTurn = await this.deps.sendMessage.repo.getActiveTurn(conversationId);
    if (!currentTurn) return;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const msg = await this.deps.queryMessage.getMessageById(r.value.messageId);
      if (msg) {
        await this.deps.sendMessage.repo.updateLastReadTurnNumber(conversationId, msg.senderId, currentTurn.turnNumber);
      }
    }
  }
}
