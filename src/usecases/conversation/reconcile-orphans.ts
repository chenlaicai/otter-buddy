import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";

/**
 * 服务重启兜底（F20260724cwgn）：重启后不存在活跃 agent，
 * 遗留 streaming/speaking 消息不可能再到达终态——置为 failed；
 * 不再有进行中消息的 open turn 关闭（恢复"open = 有进行中发言"不变量）。
 * reconcile 失败不阻断启动（孤儿残留等同于本功能引入前的行为）。
 *
 * F20260826rsme：中断消息先尝试登记自动恢复资格（claimResume 原子守卫），
 * 登记成功的消息 fail 时不插中断 notice（即将被 ResumeInterruptedService
 * 重置回 streaming 续写）；守卫拒绝（二次重启 attempts 已满）或不可恢复
 * （非 otter 消息/对话已删/参与者已离开）的消息走现状 fail+notice 语义。
 * 显式 if/else 分流保证所有 streaming/speaking 消息都被处理，无悬挂。
 *
 * F20260827mtbl：恢复登记逐条 try/catch 隔离——登记链路异常只降级该条
 * 为 fail+notice，不得中断 failInFlightMessages 清理（增强功能的故障
 * 不能带崩核心清理）。
 */
export async function reconcileOrphans(repo: ConversationRepository, logger: Logger): Promise<void> {
  try {
    const now = new Date().toISOString();
    const claimed = await repo.listInFlightOtterMessages();
    const skipNoticeIds = new Set<string>();
    const checkParticipant = async (conversationId: string, otterId: string): Promise<boolean> => {
      const participant = await repo.getParticipant(conversationId, otterId);
      return participant?.status === "active";
    };
    for (const row of claimed) {
      // F20260827mtbl: 恢复登记逐条隔离——claim 链路任何异常（如恢复队列表缺失）
      //  只降级该条为 fail+notice 现状路径，不得中断 failInFlightMessages 清理。
      //  否则增强功能（自动恢复）的故障会让核心清理（孤儿置 failed）整体夭折，
      //  streaming 孤儿跨重启永久残留（会话永久显示"运行中"且无法中断）。
      try {
        // Why: 顺序先查参与者再 claim——claim 会原子自增 attempts，
        //  participant 已失效时不应消耗恢复资格（留给真正可恢复的窗口）
        const active = await checkParticipant(row.conversationId, row.senderId);
        if (active && await repo.claimResume(row.id, row.conversationId, row.senderId, now)) {
          skipNoticeIds.add(row.id);
          logger.info(`Interrupted message queued for auto-resume`, { messageId: row.id, conversationId: row.conversationId, otterId: row.senderId });
        }
        // else：守卫拒绝或不可恢复 → 留在 fail+notice 现状路径（else 分支即「什么都不做」）
      } catch (err) {
        logger.warn(`Resume claim failed, degrading to fail+notice path`, {
          messageId: row.id, conversationId: row.conversationId, otterId: row.senderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const failed = await repo.failInFlightMessages(now, "[服务重启，发言中断]", skipNoticeIds);
    const closedTurns = await repo.closeOrphanedTurns(now);
    if (failed > 0 || closedTurns > 0) {
      logger.warn(`Reconciled orphans: ${failed} in-flight message(s) failed, ${closedTurns} orphaned turn(s) closed, ${skipNoticeIds.size} queued for auto-resume`);
    }
  } catch (err) {
    logger.error("Failed to reconcile orphans", err instanceof Error ? err : new Error(String(err)));
  }
}
