import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { SendMessage } from "./send-message";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { Logger } from "@usecases/ports/logger";
import {
  buildRestartResumeMsg,
  buildRestartResumeSystemMsg,
  buildRestartResumeFailedMsg,
} from "./agent-turn-orchestrator/retry-policy";

/**
 * F20260826rsme 服务重启自动恢复：启动完成后消费 reconcile 阶段
 * 写入的 restart_pending_resumes 队列，逐条恢复中断的 otter 发言。
 *
 * 恢复 = prepareForRetry(preserveSegments=true) 保留半截 segments
 * + DispatchChainEngine 续跑（#332：直接 invoke 会丢弃 yield 传递目标）。
 * 串行逐条：量小（单次重启 0~2 条）且规避同 conversation 的
 * sequence_num 竞态与启动风暴。
 */
export class ResumeInterruptedService {
  /** 恢复触发前的等待窗口：错开启动尾段的装配/首条用户消息并发 */
  private static readonly RESUME_DELAY_MS = 3_000;
  /** 恢复前的并发检查窗口：该窗口内有新 user 消息则跳过（审视发现 4 修复） */
  private static readonly CONCURRENT_WINDOW_MS = 3_000;

  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      queryMessage: QueryMessage;
      sendMessage: SendMessage;
      dispatchChainEngine: DispatchChainEngine;
      /** invokeFn 在装配处闭包捕获 agentInvoker（审视发现 1 修复） */
      invokeFn: (params: { otterId: string; conversationId: string; userMessageContent: string; senderId: string }) => Promise<{ messageId: string; aggregatedTargets?: string[] }>;
      logger: Logger;
      /** 测试注入假时钟/立即触发 */
      delayMs?: number;
    },
  ) {}

  /** 入口：延迟后逐条恢复。fire-and-forget 调用（不阻塞服务就绪）。 */
  async resume(): Promise<void> {
    const delay = this.deps.delayMs ?? ResumeInterruptedService.RESUME_DELAY_MS;
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const pending = await this.deps.conversationRepo.getPendingResumes();
      if (pending.length === 0) return;
      this.deps.logger.info(`Resuming interrupted messages after restart`, { count: pending.length });

      const byConversation = new Map<string, typeof pending>();
      for (const item of pending) {
        const list = byConversation.get(item.conversationId) ?? [];
        list.push(item);
        byConversation.set(item.conversationId, list);
      }
      for (const [conversationId, items] of byConversation) {
        await this.deps.sendMessage.sendSystem(conversationId, buildRestartResumeSystemMsg(items.length));
        for (const item of items) {
          await this.resumeOne(item);
        }
      }
    } catch (err) {
      this.deps.logger.error("Resume interrupted messages failed", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async resumeOne(item: { messageId: string; conversationId: string; otterId: string }): Promise<void> {
    const now = new Date().toISOString();
    try {
      // 1. 启动间隙可能被清理：conversation/otter/participant 任一失效则放弃
      const participant = await this.deps.conversationRepo.getParticipant(item.conversationId, item.otterId);
      const message = await this.deps.queryMessage.getMessageById(item.messageId);
      if (!participant || participant.status !== "active" || !message) {
        await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
        return;
      }

      // 2. 并发防护：窗口内有新 user 消息 → 跳过恢复降级手动（sequence_num 竞态最小防护）
      const lastUserMsg = await this.deps.queryMessage.getLastMessageBySenderType(item.conversationId, "user");
      if (lastUserMsg && Date.now() - Date.parse(lastUserMsg.createdAt) < ResumeInterruptedService.CONCURRENT_WINDOW_MS) {
        await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
        await this.deps.sendMessage.sendSystem(item.conversationId, buildRestartResumeFailedMsg("skipped_concurrent"));
        return;
      }

      // 3. senderId 从原所属 turn 反查（prepareForRetry 会创建全新 turn，新 turn 为空不能作锚——审视发现 3）
      const turnUserMsgs = await this.deps.queryMessage.getMessages(item.conversationId, { turnId: message.turnId, senderType: "user", limit: 1 });
      const senderId = turnUserMsgs[0]?.senderId ?? "user";

      // 4. 重置消息：failed→streaming，新 turn，半截 segments 保留（F20260821fix 语义）
      await this.deps.sendMessage.prepareForRetry(item.messageId, true);

      // 5. 链引擎续跑：消费 aggregatedTargets，恢复后 yield 交棒的链不断（#332）
      await this.deps.dispatchChainEngine.executeChain({
        conversationId: item.conversationId,
        userMessageContent: buildRestartResumeMsg(),
        senderId,
        initialTargets: [item.otterId],
        invokeFn: this.deps.invokeFn,
      });
      await this.deps.conversationRepo.updateResumeStatus(item.messageId, "done", now);
    } catch (err) {
      this.deps.logger.error("Resume one interrupted message failed", err instanceof Error ? err : new Error(String(err)), {
        messageId: item.messageId, conversationId: item.conversationId, otterId: item.otterId,
      });
      await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
      await this.deps.sendMessage.sendSystem(item.conversationId, buildRestartResumeFailedMsg("invoke_error"));
    }
  }
}
