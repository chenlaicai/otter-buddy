import type { ConversationRepository } from "./conversation-repository";
import type { EntryRepository } from "./entry-repository";
import type { InvokeRepository } from "./invoke-repository";
import type { ResumePendingRepository } from "./resume-pending-repository";
import type { DispatchChainEngine, InvokeFn } from "./dispatch-chain-engine";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import {
  buildRestartResumeMsg,
  buildRestartResumeFailedMsg,
  buildRestartResumeFailedInvokeMsg,
} from "./agent-turn-orchestrator/retry-policy";

/** 恢复队列项（getPendingResumes 返回形态的最小消费面） */
interface ResumeQueueItem {
  invokeId: string;
  conversationId: string;
  otterId: string;
  triggerEntryId: string | null;
}

/**
 * F20260916b1ea 服务重启自动恢复（invoke 模型重建版）。
 *
 * 8/28 同名机制（messages 模型）被 #886 误删（issue #992），本类按 invoke 模型
 * 重映射重建：
 * - 中断锚点：running invoke 行（原生有 trigger_entry_id / otter_id / conversation_id）
 * - 半截内容：entries 追加式天然保留，无需 prepareForRetry 保留逻辑
 * - done 判定：新 invoke 终态直读（链引擎 allSettled 吞错语义下，executeChain
 *   正常返回 ≠ invoke 成功——invokeId 捕获 + invoke 行终态直读是准确判据）
 * - 并发窗口数据源：entries 表（messages 表已退役）
 *
 * 移植旧实现（b1d11c5f^）的成熟逻辑：429/网络指数退避、跨会话并行同会话串行、
 * attempts CAS 认领、终态守卫、healing 台账落账。
 *
 * F20260917rscr：信号补扫（rescanPending/rescanSignals）已删除——9/17 重启风暴
 * （682 invoke/656 failed）实证「扫历史消息补点火」是净负资产：已读标记在主流
 * 路径不写入导致全部历史消息误判未处理。恢复机制只认 restart_pending_resumes
 * 队列（被系统停止打断的 invoke），搭档裁决（修法排序③ deletion）。
 */
export class ResumeInterruptedService {
  /** 恢复触发前的等待窗口：错开启动尾段的装配/首条用户消息并发 */
  private static readonly RESUME_DELAY_MS = 3_000;
  /** 恢复前的并发检查窗口：该窗口内有新 user entry 则跳过（审视发现 4 修复） */
  private static readonly CONCURRENT_WINDOW_MS = 3_000;
  /** 429 限流重试配置（F20260830rfto 移植） */
  private static readonly RATE_LIMIT_MAX_RETRIES = 3;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 5_000;

  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepository;
      entryRepo: EntryRepository;
      invokeRepo: InvokeRepository;
      resumePendingRepo: ResumePendingRepository;
      dispatchChainEngine: DispatchChainEngine;
      /** invokeFn 在装配处闭包捕获 agentInvoker（审视发现 1 修复，旧模式沿用） */
      invokeFn: InvokeFn;
      /** 失败/跳过的用户可见系统消息写入（装配处闭包 uc.sendEntry.createSystemEntry） */
      sendSystemEntry: (conversationId: string, body: string) => Promise<void>;
      /** #613（移植）：healing 台账写入（服务重启事件落账） */
      healingRepo?: HealingEventRepository;
      logger: Logger;
      /** 测试注入假时钟/立即触发 */
      delayMs?: number;
      /** 429 限流退避基础延迟（ms），测试可注入小值 */
      rateLimitBaseDelayMs?: number;
    },
  ) {}

  /** 入口：延迟后逐条恢复。fire-and-forget 调用（不阻塞服务就绪）。
   *  F20260917rscr：只恢复队列里的中断 invoke——不再做任何历史信号扫描。 */
  async resume(): Promise<void> {
    const delay = this.deps.delayMs ?? ResumeInterruptedService.RESUME_DELAY_MS;
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const pending = await this.deps.resumePendingRepo.getPendingResumes();
      if (pending.length === 0) return;
      this.deps.logger.info("Resuming interrupted invokes after restart", { count: pending.length });
      // #613（移植）：服务重启事件落 healing 台账（severity 按中断数分级）
      await this.recordRestartHealingEvent(pending.length);

      // F202609048840 F1（移植）：跨会话并行——不同会话并行，同会话内串行（防 seq 竞态）
      const byConversation = new Map<string, ResumeQueueItem[]>();
      for (const item of pending) {
        const list = byConversation.get(item.conversationId) ?? [];
        list.push(item);
        byConversation.set(item.conversationId, list);
      }
      await Promise.allSettled(
        Array.from(byConversation.entries()).map(async ([conversationId, items]) => {
          try {
            await this.resumeConversation(conversationId, items);
          } catch (err) {
            // 单个会话失败不阻塞其他会话
            this.deps.logger.error(`Resume conversation ${conversationId} failed`, err instanceof Error ? err : new Error(String(err)));
          }
        }),
      );
      /* F20260906rsts（沿用搭档 9/6 裁决）：成功路径零系统消息（静默成功）；
       * 失败/跳过路径的提示在 resumeItemSafe 各出口内发出。 */
    } catch (err) {
      this.deps.logger.error("Resume interrupted invokes failed", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** #613（移植）：服务重启事件落 healing 台账（try/catch non-fatal） */
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
        description: `服务重启导致 ${pendingCount} 条 invoke 中断，自动恢复流程已启动（F20260916b1ea）`,
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

  /** 单会话串行恢复（F20260830rfto 移植：单条失败不阻塞其余） */
  private async resumeConversation(conversationId: string, items: ResumeQueueItem[]): Promise<void> {
    for (const item of items) {
      await this.resumeItemSafe(item);
    }
  }

  /**
   * 单条 resume 的安全包装——捕获所有异常确保不崩循环。
   * 移植旧 resumeItemSafe 三分类语义（done/skipped/failed）。
   */
  private async resumeItemSafe(item: ResumeQueueItem): Promise<"done" | "skipped" | "failed"> {
    try {
      return await this.resumeOneWithRetry(item);
    } catch (err) {
      this.deps.logger.error("Resume item failed after retries", err instanceof Error ? err : new Error(String(err)), {
        invokeId: item.invokeId, conversationId: item.conversationId, otterId: item.otterId,
      });
      // F4 语义统一（移植）：可重试错误耗尽重试后仍标 failed（可手动重试），不说「永久放弃」。
      // 收尾异常不逃逸（对齐 markExhaustedSafe 纪律）——中断同会话剩余 items 是更坏结果。
      if (this.isRetryableNetworkError(err)) {
        await this.markFailedSafe(item, err);
      } else {
        await this.markExhaustedSafe(item.invokeId, err);
      }
      return "failed";
    }
  }

  /** 安全标记 failed（可手动重试）+ 失败文案——收尾异常不逃逸 */
  private async markFailedSafe(item: ResumeQueueItem, originalErr: unknown): Promise<void> {
    try {
      await this.deps.resumePendingRepo.settleResume(item.invokeId, "failed", new Date().toISOString());
      await this.deps.sendSystemEntry(item.conversationId, buildRestartResumeFailedInvokeMsg());
    } catch {
      this.deps.logger.error("Failed to mark resume as failed", originalErr instanceof Error ? originalErr : new Error(String(originalErr)), { invokeId: item.invokeId });
    }
  }

  /** 安全标记 exhausted——写库失败不阻塞后续 */
  private async markExhaustedSafe(invokeId: string, originalErr: unknown): Promise<void> {
    try {
      await this.deps.resumePendingRepo.settleResume(invokeId, "exhausted", new Date().toISOString());
    } catch {
      this.deps.logger.error("Failed to mark resume as exhausted", originalErr instanceof Error ? originalErr : new Error(String(originalErr)), { invokeId });
    }
  }

  /** 429 限流/网络错误的指数退避重试包装（F20260830rfto 移植） */
  private async resumeOneWithRetry(item: ResumeQueueItem): Promise<"done" | "skipped" | "failed"> {
    // CAS 认领只在恢复入口一次（attempts 语义 = 跨重启恢复次数）；进程内 429/网络退避
    // 重试不再重认领——S1 修复轮实证：认领放循环内时，1+3 次重试把 attempts 顶到上限
    // 与跨重启守卫撞车（「429 重试耗尽」用例 4 次调用只走了 3 次）
    const claimed = await this.deps.resumePendingRepo.claimPendingResume(item.invokeId);
    if (!claimed) {
      // 认领失败两类：① attempts 达上限（pending 残留，跨重启无限重试守卫触发）→ exhausted
      // 闭环；② 已被其他窗口认领/已终态（status 非 pending）→ 保持现状（那已是正确终态）
      const row = await this.deps.resumePendingRepo.getByInvokeId(item.invokeId);
      if (row?.status === "pending") {
        await this.deps.resumePendingRepo.settleResume(item.invokeId, "exhausted", new Date().toISOString());
      }
      return "skipped";
    }

    let lastErr: unknown;
    const baseDelay = this.deps.rateLimitBaseDelayMs ?? ResumeInterruptedService.RATE_LIMIT_BASE_DELAY_MS;
    for (let attempt = 0; attempt <= ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await this.resumeOne(item);
      } catch (err) {
        lastErr = err;
        if (this.isRetryableNetworkError(err) && attempt < ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.deps.logger.warn(`Resume network error, retrying after ${delay}ms`, {
            invokeId: item.invokeId,
            attempt: attempt + 1,
            maxRetries: ResumeInterruptedService.RATE_LIMIT_MAX_RETRIES,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err; // 非可重试错误或重试耗尽
      }
    }
    throw lastErr;
  }

  /** #613（移植）：判断是否为 429 限流错误 */
  private isRateLimitError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.message.includes("429") || err.message.includes("rate_limit") || err.message.includes("rate limit");
    }
    const str = String(err);
    return str.includes("429") || str.includes("rate_limit") || str.includes("rate limit");
  }

  /** F202609048840 F2（移植）：判断是否为可重试的网络/连接错误 */
  private isRetryableNetworkError(err: unknown): boolean {
    if (this.isRateLimitError(err)) return true;
    const message = err instanceof Error ? err.message : String(err);
    return this.isRetryableNetworkErrorMessage(message);
  }

  /** F202609048840 F2（移植）：网络类可重试错误的文本模式匹配 */
  private isRetryableNetworkErrorMessage(message: string): boolean {
    const retryablePatterns = [
      "Connection error",
      "timeout",
      "ECONNRESET",
      "fetch failed",
      "network error",
      "ECONNREFUSED",
      "ETIMEDOUT",
    ];
    return retryablePatterns.some(pattern => message.toLowerCase().includes(pattern.toLowerCase()));
  }

  private async resumeOne(item: ResumeQueueItem): Promise<"done" | "skipped" | "failed"> {
    try {
      // 1. CAS 认领已上提至 resumeOneWithRetry 入口（attempts 语义 = 跨重启恢复次数，
      //    进程内退避重试不重认领——见 resumeOneWithRetry 注释）
      // 2. 跳过检查：participant 失效（dissolved/inactive）→ exhausted 静默
      const participant = await this.deps.conversationRepo.getParticipant(item.conversationId, item.otterId);
      if (!participant || participant.status !== "active") {
        await this.markExhaustedSafe(item.invokeId, new Error("Participant inactive or missing"));
        return "skipped";
      }

      // 3. 并发窗口检查：恢复前 3s 内有新 user entry → exhausted + 系统消息提示手动重试
      if (await this.isConcurrentSkip(item.conversationId)) {
        await this.deps.resumePendingRepo.settleResume(item.invokeId, "exhausted", new Date().toISOString());
        await this.sendSystemSafe(item.conversationId, buildRestartResumeFailedMsg("skipped_concurrent"));
        return "skipped";
      }

      // 4. 链引擎续跑：invokeFn 包装捕获首 hop invokeId + 终态（链 allSettled 吞错语义，
      //    executeChain 正常返回 ≠ invoke 成功——invoke 行终态直读是准确判据，F4 移植）。
      const capture: { invokeId?: string; rejected?: unknown } = {};
      const captureInvokeFn: InvokeFn = async params => {
        try {
          const result = await this.deps.invokeFn(params);
          capture.invokeId = result.messageId;
          return result;
        } catch (invokeErr) {
          capture.rejected = invokeErr;
          throw invokeErr;
        }
      };
      try {
        await this.deps.dispatchChainEngine.executeChain({
          conversationId: item.conversationId,
          userMessageContent: buildRestartResumeMsg(),
          senderId: "",
          initialTargets: [item.otterId],
          triggerMessageId: item.invokeId,
          invokeFn: captureInvokeFn,
        });
      } catch (chainErr) {
        // executeChain 自身抛错（链前置失败等）= 恢复失败；可重试错误上抛交退避层
        if (this.isRetryableNetworkError(chainErr)) throw chainErr;
        return this.settleChainError(item, chainErr);
      }

      // 5. done 判定：invoke 终态直读
      return await this.settleResumedOutcome(item, capture);
    } catch (err) {
      this.deps.logger.error("Resume one interrupted invoke failed", err instanceof Error ? err : new Error(String(err)), {
        invokeId: item.invokeId, conversationId: item.conversationId, otterId: item.otterId,
      });
      if (this.isRetryableNetworkError(err)) throw err;
      await this.deps.resumePendingRepo.settleResume(item.invokeId, "exhausted", new Date().toISOString());
      await this.sendSystemSafe(item.conversationId, buildRestartResumeFailedInvokeMsg());
      return "failed";
    }
  }

  /** 链抛不可重试异常的终态收尾（F202609048840 F4 移植：标 failed 可手动重试） */
  private async settleChainError(item: ResumeQueueItem, chainErr: unknown): Promise<"failed"> {
    this.deps.logger.error("Resume chain failed (invoke error)", chainErr instanceof Error ? chainErr : new Error(String(chainErr)), {
      invokeId: item.invokeId, conversationId: item.conversationId, otterId: item.otterId,
    });
    await this.deps.resumePendingRepo.settleResume(item.invokeId, "failed", new Date().toISOString());
    await this.sendSystemSafe(item.conversationId, buildRestartResumeFailedInvokeMsg());
    return "failed";
  }

  /**
   * 链正常返回后的终态判定（F4 移植，invoke 模型版）。
   * 判据真相源 = 新 invoke 行终态直读（取代旧派发台账）：
   * - invokeFn 首 hop 拒绝（捕获到 rejected）→ invoke 失败；可重试错误上抛交退避层
   * - invoke 行 failed → 标 failed（可手动重试）+ 失败文案
   * - invoke 行 completed/查无行（观测缺失保守判成功——不因台账缺失误标失败）
   */
  private async settleResumedOutcome(
    item: ResumeQueueItem,
    capture: { invokeId?: string; rejected?: unknown },
  ): Promise<"done" | "failed"> {
    if (capture.rejected !== undefined) {
      const invokeErr = capture.rejected;
      if (this.isRetryableNetworkError(invokeErr)) throw invokeErr;
      this.deps.logger.warn("Resume invoke rejected (non-retryable)", {
        invokeId: item.invokeId, conversationId: item.conversationId, otterId: item.otterId,
        error: invokeErr instanceof Error ? invokeErr.message : String(invokeErr),
      });
      await this.deps.resumePendingRepo.settleResume(item.invokeId, "failed", new Date().toISOString());
      await this.sendSystemSafe(item.conversationId, buildRestartResumeFailedInvokeMsg());
      return "failed";
    }
    if (capture.invokeId) {
      const invoke = await this.deps.invokeRepo.getInvokeById(capture.invokeId).catch(() => null);
      if (invoke && invoke.status === "failed") {
        this.deps.logger.warn("Resume chain returned but invoke failed (terminal read = failed)", {
          invokeId: item.invokeId, conversationId: item.conversationId, otterId: item.otterId,
        });
        await this.deps.resumePendingRepo.settleResume(item.invokeId, "failed", new Date().toISOString());
        await this.sendSystemSafe(item.conversationId, buildRestartResumeFailedInvokeMsg());
        return "failed";
      }
    }
    await this.deps.resumePendingRepo.settleResume(item.invokeId, "done", new Date().toISOString());
    return "done";
  }

  /** 并发防护检查（F20260913ctlv 语义映射：messages → entries 数据源）。
   *  getEntries ORDER BY sequence_num DESC——最新一条在首位。 */
  private async isConcurrentSkip(conversationId: string): Promise<boolean> {
    const entries = await this.deps.entryRepo.getEntries(conversationId, { entryType: "user", limit: 1 });
    const lastUserEntry = entries[0];
    return !!lastUserEntry && Date.now() - Date.parse(lastUserEntry.createdAt) < ResumeInterruptedService.CONCURRENT_WINDOW_MS;
  }

  /** 系统消息发送的安全包装（失败仅日志——提示是增强面不是控制面） */
  private async sendSystemSafe(conversationId: string, body: string): Promise<void> {
    try {
      await this.deps.sendSystemEntry(conversationId, body);
    } catch (err) {
      this.deps.logger.warn("Resume system entry write failed (non-fatal)", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
