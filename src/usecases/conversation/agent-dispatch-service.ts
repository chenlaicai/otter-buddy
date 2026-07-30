import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import type { SendMessage } from "./send-message";
import type { QueryMessage } from "./query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";

export interface AgentDispatchResult {
  otterReply?: string;
  error?: string;
}

export class AgentDispatchService {
  constructor(
    private readonly sendMessageUseCase: SendMessage,
    private readonly queryMessage: QueryMessage,
    private readonly queryOtter: QueryOtter,
    private readonly agentInvoker: AgentInvoker,
    private readonly logger: Logger,
    private readonly maxChainDepth: number = 20,
  ) {}

  /** 触发 Agent 派发（非 SSE 模式，用于飞书路径） */
  async dispatchWithoutSSE(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    onOtterReply?: (otterId: string, reply: string) => void,
  ): Promise<AgentDispatchResult> {
    try {
      // 获取首轮目标
      const firstTurnTargets = await this.resolveFirstTurnTargets(conversationId);
      if (firstTurnTargets.length === 0) {
        return { error: "无可用的 Otter 参与者" };
      }

      // 执行发言链
      const reply = await this.executeChain(
        conversationId,
        userMessageContent,
        senderId,
        firstTurnTargets,
        onOtterReply,
      );

      return reply;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('Agent 派发异常', err instanceof Error ? err : new Error(msg), { conversationId });
      return { error: `Agent 派发失败: ${msg}` };
    }
  }

  private async resolveFirstTurnTargets(conversationId: string): Promise<string[]> {
    // 获取最新用户消息的 talkingStonePassedTo
    const messages = await this.queryMessage.getMessages(conversationId, { limit: 1, senderType: "user" });
    if (messages.length === 0) return [];

    const lastUserMsg = messages[0];
    return lastUserMsg.talkingStonePassedTo ?? [];
  }

  private async executeChain(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
    targets: string[],
    onOtterReply?: (otterId: string, reply: string) => void,
  ): Promise<AgentDispatchResult> {
    let depth = 0;
    let lastOtterReply: string | undefined;

    while (targets.length > 0 && depth < this.maxChainDepth) {
      depth++;

      // 每跳重建名册
      const roster = await this.buildRoster(conversationId);

      // 并行派发
      const promises = targets.map(async otterId => {
        const messageWithContext = await this.buildMessageWithContext(
          conversationId, otterId, userMessageContent, senderId, roster
        );

        this.logger.info('发言链调用', {
          otterId,
          messageLength: messageWithContext.length,
          messagePreview: messageWithContext.substring(0, 200),
        });

        return this.agentInvoker.invokeConversation({
          otterId, conversationId,
          userMessageContent: messageWithContext,
          senderId,
          onSSEEvent: () => {}, // 空操作，不推送 SSE
        });
      });

      const results = await Promise.allSettled(promises);

      // 标记已读
      await this.markBatchRead(conversationId, results);

      // 获取 Otter 回复
      for (const r of results) {
        if (r.status === "fulfilled") {
          const msg = await this.queryMessage.getMessageById(r.value.messageId);
          if (msg?.body) {
            lastOtterReply = msg.body;
            onOtterReply?.(msg.senderId, msg.body);
          }
        }
      }

      // 解析下一轮目标
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

    if (targets.length > 0) {
      this.logger.warn('发言链达到深度上限', { depth, targets, conversationId });
    }

    return { otterReply: lastOtterReply };
  }

  private async buildRoster(conversationId: string): Promise<string> {
    const participants = await this.sendMessageUseCase.repo.getActiveParticipants(conversationId);
    const lines = await Promise.all(participants.map(async p => {
      const otter = await this.queryOtter.getById(p.otterId);
      return `- ${otter?.name ?? p.otterId} (otterId: ${p.otterId})`;
    }));
    lines.push(`- 搭档（传 'user' 即交还发言权）`);
    return `## 在场成员\n${lines.join('\n')}`;
  }

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
      .map(m => `[${m.senderType === 'system' ? '系统' : m.senderId === senderId ? '搭档' : (names.get(m.senderId) ?? m.senderId)}] ${m.body ? stripHtmlCardsOnly(m.body) : ''}`)
      .join('\n');
    return `${roster}\n\n## 对话历史（你上次发言后的消息）\n${formatted}\n\n## 当前任务\n${userMessageContent}`;
  }

  private async resolveSenderNames(messages: Array<{ senderType: string; senderId: string }>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const otterSenderIds = [...new Set(messages.filter(m => m.senderType === "otter").map(m => m.senderId))];
    await Promise.all(otterSenderIds.map(async id => {
      const otter = await this.queryOtter.getById(id);
      if (otter) names.set(id, otter.name);
    }));
    return names;
  }

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
}
