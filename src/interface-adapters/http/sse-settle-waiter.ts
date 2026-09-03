import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { Logger } from "@usecases/ports/logger";

/** K3（F20260903k23）：POST SSE 等 attempt 终态的超时兜底与轮询间隔。
 *  超时 30s 覆盖正常链路（分钟级长链由 GET SSE 承载流式，POST 流只等「点火决策落地」）；
 *  busyQueue 排队信号多数能在窗口内消化；更长的排队/补扫场景由轨迹 UI 承载状态，不悬死流。 */
export const SSE_SETTLE_TIMEOUT_MS = 30_000;
const SSE_SETTLE_POLL_MS = 500;

/**
 * 等待本轮触发信号的全部 attempt 行到终态（POST SSE 关流判据，K3）。
 * 终态 = completed / failed / aborted（含 busyQueue 排队后消化、失败翻篇）。
 * 「无任何行」= 路由器未点火（如全部目标 busy 排队且无终态、或信号被丢弃）——
 * 不能无限等，靠 SSE_SETTLE_TIMEOUT_MS 兜底关流（流不悬死，状态由轨迹 UI 承载）。
 * 轮询间隔 500ms：attempt 写入是同步 sqlite，无事件订阅面，轮询是最小实现；
 * 台账未注入时立即返回（调用方回退旧关流语义）。
 */
export function awaitTriggerAttemptsSettled(
  repo: DispatchAttemptRepo | undefined,
  logger: Logger,
  conversationId: string,
  triggerMessageId: string,
): Promise<void> {
  // 台账未注入：无法观测终态，立即返回（回退「路由器返回即关流」的旧语义）
  if (!repo) return Promise.resolve();
  const settled = () => {
    const rows = repo.listAttemptsForConversation(conversationId)
      .filter(a => a.messageId === triggerMessageId);
    // 无行：路由器本轮没点火任何目标（全排队/全丢弃）——交由超时兜底，不立即关
    // （排队信号消化后会有行，届时正常终态关流）
    if (rows.length === 0) return false;
    return rows.every(a => a.status !== "in_progress");
  };
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + SSE_SETTLE_TIMEOUT_MS;
    const tick = () => {
      try {
        if (settled() || Date.now() >= deadline) { resolve(); return; }
      } catch { resolve(); return; } // 查询异常：关流（轨迹 UI 承载状态，流不承载）
      setTimeout(tick, SSE_SETTLE_POLL_MS);
    };
    tick();
  });
}
