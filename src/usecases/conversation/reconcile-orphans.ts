import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";

/**
 * 服务重启兜底（F20260724cwgn 原始语义：孤儿 open turn 清理）。
 *
 * F20260910ctlv 演进：
 * - 批4a：自动恢复登记链路（claimResume → ResumeInterruptedService）随 messages 停写退役
 * - 批4c：messages 表 drop——failInFlightMessages（streaming 孤儿置 failed）失去对象，
 *   invoke 侧由 bootstrap/database.ts 的 failRunningInvokes 接管（重启 reconcile 语义）。
 *   本函数只剩 closeOrphanedTurns（写 turns 表，保留）：关闭无进行中 invoke 的 open turn。
 * reconcile 失败不阻断启动。
 */
export async function reconcileOrphans(repo: ConversationRepository, logger: Logger): Promise<void> {
  try {
    const closedTurns = await repo.closeOrphanedTurns(new Date().toISOString());
    if (closedTurns > 0) {
      logger.warn(`Reconciled orphans: ${closedTurns} orphaned turn(s) closed`);
    }
  } catch (err) {
    logger.error("Failed to reconcile orphans", err instanceof Error ? err : new Error(String(err)));
  }
}
