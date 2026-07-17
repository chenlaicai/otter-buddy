import { isTerminalMessageStatus } from "@entities/conversation/message";
import { canCloseTurn } from "@entities/conversation/conversation";
import type { ConversationRepository } from "./conversation-repository";

/** 尝试关闭 Turn（当 Turn 内所有消息到达终态时） */
export async function tryCloseTurn(
  repo: ConversationRepository,
  turnId: string,
): Promise<void> {
  const messages = await repo.getMessagesByTurnId(turnId);
  const allTerminal = messages.every((m) => isTerminalMessageStatus(m.status));
  if (canCloseTurn(allTerminal)) {
    await repo.closeTurn(turnId, new Date().toISOString());
  }
}
