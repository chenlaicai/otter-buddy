/**
 * F20260930roiv：启动窗口期孤儿 invoke 延迟 reconcile 装配。
 *
 * 从 app.ts 抽出（搭档 9/30 指正：行数约束的本意是反思文件膨胀，不是压空行）。
 * app.ts 只留调用点，实现细节集中在此。
 */
import type Database from "better-sqlite3";
import type { Logger } from "@usecases/ports/logger";
import type { Repositories } from "./types";
import { reconcileRunningInvokes } from "./database";

export interface DelayedReconcileOptions {
  enableDelayedReconcile?: boolean;
}

/** 启动窗口期孤儿 invoke 延迟 reconcile 设置 */
export function setupDelayedReconcile(
  options: DelayedReconcileOptions,
  db: Database.Database,
  repos: Repositories,
  logger: Logger,
): ReturnType<typeof setTimeout> | undefined {
  if (!(options.enableDelayedReconcile ?? true)) return undefined;
  const bootTs = new Date().toISOString();
  const timer = setTimeout(() => {
    reconcileRunningInvokes(db, repos, logger, bootTs).catch((err) => {
      logger.warn("Delayed reconcile failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 10000); // 无实证依据的保守值，覆盖观测到的 78s 窗口期（见特性文档）
  if (timer.unref) timer.unref();
  return timer;
}

/** PatrolWorker invoke-orphan-reconcile 职责工厂 */
export function createInvokeOrphanReconcileDuty(
  db: Database.Database,
  repos: Repositories,
  logger: Logger,
) {
  const bootTs = new Date().toISOString();
  return {
    name: "invoke-orphan-reconcile" as const,
    run: async () => {
      await reconcileRunningInvokes(db, repos, logger, bootTs);
    },
  };
}
