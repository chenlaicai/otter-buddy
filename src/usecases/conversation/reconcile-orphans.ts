import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";

/**
 * 服务重启兜底（F20260724cwgn）：重启后不存在活跃 agent，
 * 遗留 streaming/speaking 消息不可能再到达终态——置为 failed；
 * 不再有进行中消息的 open turn 关闭（恢复"open = 有进行中发言"不变量）。
 * reconcile 失败不阻断启动（孤儿残留等同于本功能引入前的行为）。
 */
export async function reconcileOrphans(repo: ConversationRepository, logger: Logger): Promise<void> {
  try {
    const now = new Date().toISOString();
    const failed = await repo.failInFlightMessages(now, "[服务重启，发言中断]");
    const closedTurns = await repo.closeOrphanedTurns(now);
    if (failed > 0 || closedTurns > 0) {
      logger.warn(`Reconciled orphans: ${failed} in-flight message(s) failed, ${closedTurns} orphaned turn(s) closed`);
    }
  } catch (err) {
    logger.error(`Failed to reconcile orphans: ${err}`);
  }
}
