import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Logger } from "@usecases/ports/logger";

/** K3（F20260903k23 → F20260908rlcp → F20260910ctlv）：POST SSE 等触发信号产出终态的超时兜底与轮询。
 *  F20260910ctlv 彻底切换补漏：判据从 messages 行改到 invokes 行——
 *  触发 entry 的 tsp 目标獭是否还有 running invoke（无 → 本轮产出已终态）。
 *  30s 超时覆盖正常链路；更长排队由常驻 GET SSE 承载流式。 */
export const SSE_SETTLE_TIMEOUT_MS = 30_000;
const SSE_SETTLE_POLL_MS = 500;

/**
 * 等待本轮触发信号的产出到达终态（POST SSE 关流判据）。
 *
 * 判据：触发 entry 的 yieldTargets 指向的 otter 目标是否全部无 running invoke。
 * entry 查不到（异常）→ 视为 settled（不挂流）。
 */
export function awaitTriggerAttemptsSettled(
  repos: { entryRepo?: EntryRepository; invokeRepo?: InvokeRepository },
  logger: Logger,
  conversationId: string,
  triggerEntryId: string,
): Promise<void> {
  const settled = async (): Promise<boolean> => {
    try {
      const entry = await repos.entryRepo?.getEntryById(triggerEntryId);
      if (!entry) return true;
      const targets = (entry.yieldTargets ?? []).filter(t => t !== "user");
      if (targets.length === 0) return true;

      // 检查每个目标是否还有 running invoke
      for (const targetId of targets) {
        const active = await repos.invokeRepo?.getActiveInvokeByOtterId(conversationId, targetId);
        if (active) return false;
      }
      return true;
    } catch (err) {
      logger.warn("[k3] settle 轮询异常（兜底关流）", { conversationId, triggerEntryId, error: err instanceof Error ? err.message : String(err) });
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
