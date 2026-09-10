/**
 * F20260910ctlv 彻底切换：Turn 关闭判据从 messages 行剥离到 invokes 行。
 *
 * Why: messages 停写 UI 消息后，turn 内的「参与者产出」唯一状态机是 invokes 表
 * （running/completed/failed/aborted）。turn 关闭 = turn 内全部 invoke 到终态。
 *
 * 聚合目标（yield 去向）：读 turn 内 yield entries 的 yieldTargets（entries 表），
 * 替代旧「turn 内所有 messages 的 talkingStonePassedTo 并集」。
 */

import type { ConversationRepository } from "./conversation-repository";
import type { InvokeRepository } from "./invoke-repository";
import type { EntryRepository } from "./entry-repository";

/** Turn 关闭结果 */
export interface TurnCloseResult {
  closed: boolean;
  /** 聚合的发言石目标（去重后的 yieldTargets） */
  aggregatedTargets: string[];
}

/**
 * 尝试关闭 Turn（当 Turn 内所有 invoke 到达终态时），返回聚合的发言石目标。
 *
 * invoke 终态：completed / failed / aborted（running = 仍在产出，不关）。
 * 兜底：turn 内查不到任何 invoke（异常路径）→ 直接关闭（与旧实现
 * 「空消息数组 every() 恒真」的语义一致）。
 */
export async function tryCloseTurn(
  conversationRepo: ConversationRepository,
  turnId: string,
  deps?: { invokeRepo?: InvokeRepository; entryRepo?: EntryRepository },
): Promise<TurnCloseResult> {
  // F20260910ctlv 彻底切换：invokeRepo 未注入时（旧装配/测试）降级查 messages 行（兼容测试桩）
  if (!deps?.invokeRepo) {
    return closeTurnFromMessages(conversationRepo, turnId);
  }

  const invokes = await deps.invokeRepo.getInvokesByTurnId(turnId);
  const allTerminal = invokes.every((inv) => inv.status !== "running");
  if (!allTerminal) {
    return { closed: false, aggregatedTargets: [] };
  }

  await conversationRepo.closeTurn(turnId, new Date().toISOString());

  /** 聚合 turn 内 yield entries 的 yieldTargets（invokeRepo 终态里的 tsp 是最后 yield 的去向，
   *  yield entry 才是逐次交棒记录；无 yield entry 的 turn（全部失败）聚合 invoke.tsp 兜底） */
  const targets = await aggregateTurnTargets(deps, turnId, invokes);
  return { closed: true, aggregatedTargets: targets };
}

/** yield entries 聚合 + invoke.tsp 兜底 */
async function aggregateTurnTargets(
  deps: { entryRepo?: EntryRepository },
  turnId: string,
  invokes: Array<{ talkingStonePassedTo: string[] | null }>,
): Promise<string[]> {
  const targets = new Set<string>();
  if (deps.entryRepo) {
    const yieldEntries = await deps.entryRepo.getEntriesByTurnId(turnId, "yield");
    for (const e of yieldEntries) {
      for (const id of e.yieldTargets ?? []) targets.add(id);
    }
  }
  if (targets.size === 0) {
    for (const inv of invokes) {
      for (const id of inv.talkingStonePassedTo ?? []) targets.add(id);
    }
  }
  return [...targets];
}

/** messages 行降级路径（invokeRepo 未注入的旧装配） */
async function closeTurnFromMessages(
  conversationRepo: ConversationRepository,
  turnId: string,
): Promise<TurnCloseResult> {
  const { isTerminalMessageStatus } = await import("@entities/conversation/message");
  const { canCloseTurn } = await import("@entities/conversation/conversation");
  const messages = await conversationRepo.getMessagesByTurnId(turnId);
  const allTerminal = messages.every((m) => isTerminalMessageStatus(m.status));
  if (!canCloseTurn(allTerminal)) {
    return { closed: false, aggregatedTargets: [] };
  }
  await conversationRepo.closeTurn(turnId, new Date().toISOString());
  const targets = new Set<string>();
  for (const msg of messages) {
    if (msg.talkingStonePassedTo) {
      for (const id of msg.talkingStonePassedTo) targets.add(id);
    }
  }
  return { closed: true, aggregatedTargets: [...targets] };
}
