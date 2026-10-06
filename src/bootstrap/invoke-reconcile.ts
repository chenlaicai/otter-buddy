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

/** #1241（F20261006opid）：pid 归属判据装配。旧 bootTs 时间戳守卫对事故形态
 *  （旧进程晚写入，started_at 晚于新进程 boot）永远跳过；pid 判据无此盲区——
 *  非本进程 pid 的 running 无论写入时间均可精确清理。 */
export function buildInvokeOrphanGuard(): { excludePid: number; beforeTs: string } {
  return { excludePid: process.pid, beforeTs: new Date().toISOString() };
}

/** 启动窗口期孤儿 invoke 延迟 reconcile 设置 */
export function setupDelayedReconcile(
  options: DelayedReconcileOptions,
  db: Database.Database,
  repos: Repositories,
  logger: Logger,
): ReturnType<typeof setTimeout> | undefined {
  if (!(options.enableDelayedReconcile ?? true)) return undefined;
  const guard = buildInvokeOrphanGuard();
  const timer = setTimeout(() => {
    reconcileRunningInvokes(db, repos, logger, guard).catch((err) => {
      logger.warn("Delayed reconcile failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, 10000); // 无实证依据的保守值（事故观测窗口约 78s，pid 判据下仅影响首次发现时延，不再影响能否清理）
  if (timer.unref) timer.unref();
  return timer;
}

/** PatrolWorker invoke-orphan-reconcile 职责工厂 */
export function createInvokeOrphanReconcileDuty(
  db: Database.Database,
  repos: Repositories,
  logger: Logger,
) {
  const guard = buildInvokeOrphanGuard();
  return {
    name: "invoke-orphan-reconcile" as const,
    run: async () => {
      await reconcileRunningInvokes(db, repos, logger, guard);
    },
  };
}
