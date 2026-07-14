/** Session 状态 */
export type SessionStatus = "active" | "archived" | "restarted";

/** Otter Session 实体（链式，记录会话窗口历史） */
export interface OtterSession {
  id: string;
  otterId: string;
  status: SessionStatus;
  previousSessionId: string | null; // 前序 Session，形成链表。首个 Session 为 null
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
}

/**
 * 是否可以归档 Session。
 * 仅 active 状态的 Session 可被归档。
 * 来源：旧 adapter.ts archiveSession() 方法中的状态校验
 */
export function canArchiveSession(status: SessionStatus): boolean {
  return status === "active";
}

/**
 * 归档原因到 Session 状态的映射。
 * 'restart' -> 'restarted'，其余 -> 'archived'
 * 来源：D36 示例 + 旧 repo archiveSession() 逻辑提取（旧 adapter 本身不做映射，映射在 repo 中）
 */
export function archiveReasonToSessionStatus(reason: string): SessionStatus {
  if (reason === "restart") {
    return "restarted";
  }
  return "archived";
}
