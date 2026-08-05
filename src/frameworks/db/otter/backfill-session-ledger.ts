import type Database from "better-sqlite3";
import { buildNewSession } from "@entities/otter/otter-session";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20260805rsto 存量迁移：为「agent_sessions 有行但 otter_sessions 无 active 行」的獭
 * 补登记首世 domain session。
 *
 * 背景：修复前日常对话只建 agent 层会话，从不建 domain 账本行，导致这些獭的
 * restart/dissolve 因查不到 active session 而跳过封存与 agent reset（空操作）。
 *
 * 幂等：已有 active session 即跳过；单条失败仅告警，不阻塞启动。
 */
export async function backfillSessionLedger(
  db: Database.Database,
  otterRepo: OtterRepository,
  logger: Logger,
): Promise<void> {
  const rows = db
    .prepare("SELECT otter_id, created_at FROM agent_sessions")
    .all() as Array<{ otter_id: string; created_at: string }>;

  let backfilled = 0;
  for (const row of rows) {
    try {
      const otter = await otterRepo.getById(row.otter_id);
      if (!otter || otter.status !== "active") continue;
      const active = await otterRepo.getActiveSession(row.otter_id);
      if (active) continue;
      /** startedAt 取 agent 会话的创建时刻作近似——比补登记时刻更贴近獭的真实「出生」 */
      const session = buildNewSession(row.otter_id, null);
      session.startedAt = row.created_at;
      await otterRepo.createSession(session);
      backfilled++;
    } catch (err) {
      logger.warn("Session ledger backfill failed for otter", {
        otterId: row.otter_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (backfilled > 0) {
    logger.info("Session ledger backfilled", {
      backfilled,
      scanned: rows.length,
      action: "session_ledger_backfill",
    });
  }
}
