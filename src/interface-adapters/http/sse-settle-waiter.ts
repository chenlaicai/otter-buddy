import type { QueryMessage } from "@usecases/conversation/query-message";
import type { Logger } from "@usecases/ports/logger";

/** K3（F20260903k23 → F20260908rlcp）：POST SSE 等消息终态的超时兜底与轮询间隔。
 *  F20260908rlcp：从 dispatch_attempts 台账改为消息状态机。
 *  超时 30s 覆盖正常链路；更长的排队/补扫场景由 GET SSE 承载流式。 */
export const SSE_SETTLE_TIMEOUT_MS = 30_000;
const SSE_SETTLE_POLL_MS = 500;

/**
 * F20260908rlcp：等待本轮触发信号对应的产出消息到达终态（POST SSE 关流判据）。
 *
 * 判据：triggerMessageId 的 tsp 指向的 otter 目标是否全部有终态消息
 * （completed/failed/aborted，即不再 streaming）。30s 超时兜底保留。
 */
export function awaitTriggerAttemptsSettled(
  queryMessage: QueryMessage | undefined,
  logger: Logger,
  conversationId: string,
  triggerMessageId: string,
): Promise<void> {
  if (!queryMessage) return Promise.resolve();
  const settled = async (): Promise<boolean> => {
    try {
      const triggerMsg = await queryMessage.getMessageById(triggerMessageId);
      if (!triggerMsg) return true;
      const targets = (triggerMsg.talkingStonePassedTo ?? []).filter(t => t !== "user");
      if (targets.length === 0) return true;

      // 检查每个目标是否有在 streaming 状态的消息
      for (const targetId of targets) {
        const last = await queryMessage.getMessages(conversationId, { senderType: "otter", limit: 1 });
        // 取该目标最新消息看是否还在 streaming
        const targetMsgs = last.filter(m => m.senderId === targetId);
        if (targetMsgs.length > 0 && targetMsgs[0]!.status === "streaming") return false;
      }
      return true;
    } catch {
      return true;
    }
  };
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + SSE_SETTLE_TIMEOUT_MS;
    const tick = () => {
      settled().then(
        done => {
          if (done || Date.now() >= deadline) { resolve(); return; }
          setTimeout(tick, SSE_SETTLE_POLL_MS);
        },
        () => resolve(),
      );
    };
    tick();
  });
}
