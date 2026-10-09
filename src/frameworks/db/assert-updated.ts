import type Database from "better-sqlite3";

/**
 * UPDATE 回执 fail-closed 断言（#1391，#1370 族模式收敛）。
 *
 * better-sqlite3 的 UPDATE 在 WHERE 不匹配时返回 changes=0 但不抛错——
 * 直接吞掉会让状态流转假成功（调用方以为写入了，实际什么都没发生）。
 * 本断言统一六处同族修复（healing / feature / research / scheduled-task /
 * im-connection / conversation 仓的 updateStatus）的抛错口径。
 */
export function assertUpdated(
  result: Database.RunResult,
  entityLabel: string,
  id: string,
): void {
  if (result.changes === 0) {
    throw new Error(`${entityLabel} 不存在: ${id}`);
  }
}
