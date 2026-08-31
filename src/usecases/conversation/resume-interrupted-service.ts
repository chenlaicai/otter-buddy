import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { SendMessage } from "./send-message";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { Logger } from "@usecases/ports/logger";
import {
  buildRestartResumeMsg,
  buildRestartResumeSystemMsg,
  buildRestartResumeFailedMsg,
  buildRestartResumeTerminalMsg,
} from "./agent-turn-orchestrator/retry-policy";
import { canFailMessage } from "@entities/conversation/message";

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
  /** F20260830rfto: 429 限流重试配置 */
  private static readonly RATE_LIMIT_MAX_RETRIES = 3;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 5_000;

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
      /** F20260830rfto: 429 限流退避基础延迟（ms），测试可注入小值 */
      rateLimitBaseDelayMs?: number;
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
      // F20260830rfto: 每个 conversation 独立 try/catch，一条失败不阻塞其余
      for (const [conversationId, items] of byConversation) {
        await this.resumeConversation(conversationId, items);
      }
    } catch (err) {
      this.deps.logger.error("Resume interrupted messages failed", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** F20260830rfto: 单个 conversation 的恢复——sendSystem 失败不阻塞消费 */
  private async resumeConversation(
    conversationId: string,
    items: Array<{ messageId: string; conversationId: string; otterId: string }>,
  ): Promise<void> {
    try {
      await this.deps.sendMessage.sendSystem(conversationId, buildRestartResumeSystemMsg(items.length));
    } catch (err) {
      this.deps.logger.warn("Resume sendSystem failed, continuing with resume", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const item of items) {
      await this.resumeItemSafe(item);
    }
  }

  /** F20260830rfto: 单条 resume 的安全包装——捕获所有异常确保不崩循环 */
  private async resumeItemSafe(item: { messageId: string; conversationId: string; otterId: string }): Promise<void> {
    try {
      await this.resumeOneWithRetry(item);
    } catch (err) {
      this.deps.logger.error("Resume item failed after retries", err instanceof Error ? err : new Error(String(err)), {
        messageId: item.messageId, conversationId: item.conversationId, otterId: item.otterId,
      });
      await this.markExhaustedSafe(item.messageId, err);
    }
  }

  /** 安全标记 exhausted——updateResumeStatus 失败不阻塞后续 */
  private async markExhaustedSafe(messageId: string, originalErr: unknown): Promise<void> {
    try {
      await this.deps.conversationRepo.updateResumeStatus(messageId, "exhausted", new Date().toISOString());
    } catch {
      this.deps.logger.error("Failed to mark resume as exhausted", originalErr instanceof Error ? originalErr : new Error(String(originalErr)), { messageId });
    }
  }

  private getRateLimitBaseDelayMs(): number {
    return this.deps.rateLimitBaseDelayMs ?? ResumeInterruptedService.RATE_LIMIT_BASE_DELAY_MS;
  }

  /** F20260830rfto: resumeOne 外层包装——429 限流时指数退避重试 */
  private async resumeOneWithRetry(item: { messageId: string; conversationId: string; otterId: string }): Promise<void> {
    let lastErr: unknown;
    const baseDelay = this.getRateLimitBaseDelayMs();
    for (let attempt = 0; attempt <= ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        await this.resumeOne(item);
        return; // 成功
      } catch (err) {
        lastErr = err;
        if (this.isRateLimitError(err) && attempt < ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.deps.logger.warn(`Resume rate limited, retrying after ${delay}ms`, {
            messageId: item.messageId,
            attempt: attempt + 1,
            maxRetries: ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err; // 非限流错误或重试耗尽
      }
    }
    throw lastErr;
  }

  /** 检查错误是否为429 限流 */
  private isRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.message.includes("429") || err.message.includes("rate_limit") || err.message.includes("rate limit");
    }
    const str = String(err);
    return str.includes("429") || str.includes("rate_limit") || str.includes("rate limit");
  }

  private async resumeOne(item: { messageId: string; conversationId: string; otterId: string }): Promise<void> {
    const now = new Date().toISOString();
    /** #599：finally 终态守卫用——try 成功为 done，catch 降级为 failed */
    let outcome: "done" | "failed" = "done";
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
      outcome = "failed";
      this.deps.logger.error("Resume one interrupted message failed", err instanceof Error ? err : new Error(String(err)), {
        messageId: item.messageId, conversationId: item.conversationId, otterId: item.otterId,
      });
      // F20260830rfto: 429/限流类错误向上传播，由 resumeOneWithRetry 退避重试；
      // 非限流错误在此标记 exhausted 并通知用户（不可重试的失败快速闭环）
      if (this.isRateLimitError(err)) {
        throw err;
      }
      await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
      await this.deps.sendMessage.sendSystem(item.conversationId, buildRestartResumeFailedMsg("invoke_error"));
    } finally {
      await this.finalizeResumedMessage(item, outcome);
    }
  }

  /**
   * #599：终态守卫——链结束后收尾旧消息。
   * Why: executeChain 是 allSettled 吞错语义（processHopResults 对 invoke 失败只记
   * 日志不上抛），Lock timeout 等恢复失败不进 catch；而 prepareForRetry 已把旧消息
   * 复位回 streaming，无人收尾即僵尸发言（#599 现场：用户被迫 3 次手动中断）。
   * 成功路径同理：invoke 创建的是新消息（sendMessage.start 新 ID），本条 streaming
   * 消息此后再无写入者，一并收尾归档（半截内容已保留在 segments）。
   * canFailMessage 守卫确保 completed/aborted 终态不受影响；守卫自身异常不外抛。
   */
  private async finalizeResumedMessage(
    item: { messageId: string; conversationId: string },
    outcome: "done" | "failed",
  ): Promise<void> {
    try {
      const msg = await this.deps.queryMessage.getMessageById(item.messageId);
      if (msg && canFailMessage(msg.status)) {
        await this.deps.sendMessage.fail(item.messageId, buildRestartResumeTerminalMsg(outcome));
        // 建议发现1处置（delta 复核）：failed 的系统消息带「可手动重试」操作指引，保留流内可见；
        // done 路径旧消息 body 已说明去向且紧邻新发言本体，流内系统消息纯冗余，省略
        if (outcome === "failed") {
          await this.deps.sendMessage.sendSystem(item.conversationId, buildRestartResumeTerminalMsg(outcome));
        }
      }
    } catch (guardErr) {
      this.deps.logger.error("Resume terminal guard failed", guardErr instanceof Error ? guardErr : new Error(String(guardErr)), {
        messageId: item.messageId, conversationId: item.conversationId,
      });
    }
  }
}
