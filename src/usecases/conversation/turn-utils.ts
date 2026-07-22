import { isTerminalMessageStatus } from "@entities/conversation/message";
import { canCloseTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";

/** Turn 关闭结果 */
export interface TurnCloseResult {
  closed: boolean;
  /** 聚合的发言石目标（去重后的 talkingStonePassedTo） */
  aggregatedTargets: string[];
}

/** 尝试关闭 Turn（当 Turn 内所有消息到达终态时），返回聚合的发言石目标 */
export async function tryCloseTurn(
  repo: ConversationRepository,
  turnId: string,
): Promise<TurnCloseResult> {
  const messages = await repo.getMessagesByTurnId(turnId);
  const allTerminal = messages.every((m) => isTerminalMessageStatus(m.status));
  if (!canCloseTurn(allTerminal)) {
    return { closed: false, aggregatedTargets: [] };
  }

  await repo.closeTurn(turnId, new Date().toISOString());

  /** 聚合所有消息的 talkingStonePassedTo */
  const targets = new Set<string>();
  for (const msg of messages) {
    if (msg.talkingStonePassedTo) {
      for (const id of msg.talkingStonePassedTo) {
        targets.add(id);
      }
    }
  }

  return { closed: true, aggregatedTargets: [...targets] };
}
