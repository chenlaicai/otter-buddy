import type { ConversationRepository } from "./conversation-repository";
import type { QueryMessage } from "./query-message";
import type { SendMessage } from "./send-message";
import type { DispatchChainEngine } from "./dispatch-chain-engine";
import type { SignalRouter } from "./signal-router";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import {
  buildRestartResumeMsg,
  buildRestartResumeSystemMsg,
  buildRestartResumeFailedMsg,
  buildRestartResumeTerminalMsg,
  buildRestartResumeCompletedMsg,
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
      /** F20260901sgpv P1：信号路由器（可选）——注入后启动补扫含信号补路由
       *  （崩溃窗口内未点火信号的克星）；恢复链本身仍走链引擎 */
      signalRouter?: SignalRouter;
      logger: Logger;
      /** #613：healing 台账写入（服务重启事件落账，观测层闭环） */
      healingRepo?: HealingEventRepository;
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

      // F20260901sgpv P1：信号补扫（崩溃窗口兑底）——无论是否有中断发言，都扫一遍
      // 信号未消费积压：服务崩溃时写路径没能点火的信号在此补路由。放在恢复链之前，
      // 让补扫信号与恢复链在同一竞争面（路由器串行化）内消化，不与恢复 invoke 撞车
      if (this.deps.signalRouter) {
        await this.deps.signalRouter.routeAllPending().catch(err => {
          this.deps.logger.warn("signal rescan on resume failed", { error: err instanceof Error ? err.message : String(err) });
        });
      }

      if (pending.length === 0) return;
      this.deps.logger.info(`Resuming interrupted messages after restart`, { count: pending.length });
      // #613：服务重启事件落 healing 台账（severity 按中断发言数分级）
      await this.recordRestartHealingEvent(pending.length);

      const byConversation = new Map<string, typeof pending>();
      for (const item of pending) {
        const list = byConversation.get(item.conversationId) ?? [];
        list.push(item);
        byConversation.set(item.conversationId, list);
      }
      // F20260830rfto: 每个 conversation 独立 try/catch，一条失败不阻塞其余
      const results = new Map<string, { resumed: number; skipped: number; failed: number }>();
      for (const [conversationId, items] of byConversation) {
        const result = await this.resumeConversation(conversationId, items);
        results.set(conversationId, result);
      }
      // #613 方案 A：恢复完成终态消息（成功路径与失败路径的 [错误] 消息对称）
      for (const [conversationId, result] of results) {
        await this.sendCompletedSafe(conversationId, result);
      }
    } catch (err) {
      this.deps.logger.error("Resume interrupted messages failed", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** #613：安全发送恢复完成终态消息——失败不阻塞主流程 */
  private async sendCompletedSafe(
    conversationId: string,
    result: { resumed: number; skipped: number; failed: number },
  ): Promise<void> {
    try {
      await this.deps.sendMessage.sendSystem(
        conversationId,
        buildRestartResumeCompletedMsg(result.resumed, result.skipped, result.failed),
      );
    } catch (err) {
      this.deps.logger.warn("Resume completed sendSystem failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** #613：服务重启事件落 healing 台账（try/catch non-fatal，对齐 notifyTaskErrored 模式） */
  private async recordRestartHealingEvent(pendingCount: number): Promise<void> {
    if (!this.deps.healingRepo) return;
    const severity = pendingCount >= 5 ? "high" : pendingCount >= 2 ? "medium" : "low";
    try {
      await this.deps.healingRepo.create({
        id: crypto.randomUUID(),
        messageId: "",
        conversationId: "",
        otterId: "",
        errorType: "other",
        severity,
        description: `服务重启导致 ${pendingCount} 条发言中断，自动恢复流程已启动（#613）`,
        suggestion: "确认恢复终态消息是否正常到达对话；若恢复失败请检查 invoke 链路",
        context: { interruptedCount: pendingCount },
        status: "open",
        resolution: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      });
    } catch (err) {
      this.deps.logger.warn("Resume restart healing event write failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** F20260830rfto: 单个 conversation 的恢复——sendSystem 失败不阻塞消费 */
  private async resumeConversation(
    conversationId: string,
    items: Array<{ messageId: string; conversationId: string; otterId: string }>,
  ): Promise<{ resumed: number; skipped: number; failed: number }> {
    let resumed = 0;
    let skipped = 0;
    let failed = 0;
    try {
      await this.deps.sendMessage.sendSystem(conversationId, buildRestartResumeSystemMsg(items.length));
    } catch (err) {
      this.deps.logger.warn("Resume sendSystem failed, continuing with resume", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const item of items) {
      const outcome = await this.resumeItemSafe(item);
      // 检视发现1（#617）：skipped（stale 数据清理/并发窗口跳过，消息已 exhausted）
      // 与 failed（恢复失败，可手动重试）分开统计——「请手动重试」对 stale 数据无操作意义
      if (outcome === "done") resumed++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }
    return { resumed, skipped, failed };
  }

  /**
   * F20260830rfto: 单条 resume 的安全包装——捕获所有异常确保不崩循环。
   * #617 检视发现1：返回三分类 outcome（done/skipped/failed）而非 boolean，
   * 让 stale 数据清理路径与真实恢复失败在终态消息中区分呈现。
   */
  private async resumeItemSafe(item: { messageId: string; conversationId: string; otterId: string }): Promise<"done" | "skipped" | "failed"> {
    try {
      return await this.resumeOneWithRetry(item);
    } catch (err) {
      this.deps.logger.error("Resume item failed after retries", err instanceof Error ? err : new Error(String(err)), {
        messageId: item.messageId, conversationId: item.conversationId, otterId: item.otterId,
      });
      await this.markExhaustedSafe(item.messageId, err);
      return "failed";
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
  private async resumeOneWithRetry(item: { messageId: string; conversationId: string; otterId: string }): Promise<"done" | "skipped" | "failed"> {
    let lastErr: unknown;
    const baseDelay = this.getRateLimitBaseDelayMs();
    for (let attempt = 0; attempt <= ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await this.resumeOne(item);
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

  /** #613 提取：判断是否为 429 限流错误 */
  private isRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.message.includes("429") || err.message.includes("rate_limit") || err.message.includes("rate limit");
    }
    const str = String(err);
    return str.includes("429") || str.includes("rate_limit") || str.includes("rate limit");
  }

  private async resumeOne(item: { messageId: string; conversationId: string; otterId: string }): Promise<"done" | "skipped" | "failed"> {
    const now = new Date().toISOString();
    /** #599：finally 终态守卫用——try 成功为 done，catch 降级为 failed */
    let outcome: "done" | "failed" = "done";
    try {
      // 1. 启动间隙可能被清理：conversation/otter/participant 任一失效则放弃
      const participant = await this.deps.conversationRepo.getParticipant(item.conversationId, item.otterId);
      const message = await this.deps.queryMessage.getMessageById(item.messageId);
      if (!participant || participant.status !== "active" || !message) {
        await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
        return "skipped";
      }

      // 2. 并发防护：窗口内有新 user 消息 → 跳过恢复降级手动（sequence_num 竞态最小防护）
      if (await this.isConcurrentSkip(item.conversationId)) {
        await this.deps.conversationRepo.updateResumeStatus(item.messageId, "exhausted", now);
        await this.deps.sendMessage.sendSystem(item.conversationId, buildRestartResumeFailedMsg("skipped_concurrent"));
        return "skipped";
      }

      await this.executeResumeChain(item, message.turnId);
      await this.deps.conversationRepo.updateResumeStatus(item.messageId, "done", now);
      return "done";
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
      return "failed";
    } finally {
      await this.finalizeResumedMessage(item, outcome);
    }
  }

  /** #613 提取：单条恢复的核心步骤（senderId 反查 + prepareForRetry + 链引擎续跑） */
  private async executeResumeChain(item: { messageId: string; conversationId: string; otterId: string }, turnId: string): Promise<void> {
    // 3. senderId 从原所属 turn 反查（prepareForRetry 会创建全新 turn，新 turn 为空不能作锚——审视发现 3）。
    //    反查落空的纯獭链发言（无用户消息）：曾兑底字面量 'user'——那是幽灵 sender 的帮凶
    //    （2026-09-04 排查）。改为兑底 ''：senderId 语义是「触发者」，纯獭链恢复时
    //    触发者是系统而非用户，宁空不假（下游仅用于展示名解析，空串走层 3 前端 fallback）。
    const turnUserMsgs = await this.deps.queryMessage.getMessages(item.conversationId, { turnId, senderType: "user", limit: 1 });
    const senderId = turnUserMsgs[0]?.senderId ?? "";
    // 4. 重置消息：failed→streaming，新 turn，半截 segments 保留（F20260821fix 语义）
    await this.deps.sendMessage.prepareForRetry(item.messageId, true);
    // 5. 链引擎续跑：读产出消息行级 tsp，恢复后 yield 交棒的链不断（#332；F20260904schf
    // 起链引擎不再消费 turn 级 aggregatedTargets）
    await this.deps.dispatchChainEngine.executeChain({
      conversationId: item.conversationId,
      userMessageContent: buildRestartResumeMsg(),
      senderId,
      initialTargets: [item.otterId],
      // F20260902sgp2 S1：resume 续跑记账——触发消息 = 被恢复的半截消息（item.messageId）
      triggerMessageId: item.messageId,
      invokeFn: this.deps.invokeFn,
    });
  }

  /** #613 提取：并发防护检查（窗口内有新 user 消息则跳过） */
  private async isConcurrentSkip(conversationId: string): Promise<boolean> {
    const lastUserMsg = await this.deps.queryMessage.getLastMessageBySenderType(conversationId, "user");
    return !!(lastUserMsg && Date.now() - Date.parse(lastUserMsg.createdAt) < ResumeInterruptedService.CONCURRENT_WINDOW_MS);
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
