/** Session 状态 */
export type SessionStatus = "active" | "archived" | "restarted";

/**
 * Session 交接摘要（B-CS-1 结构化摘要）。
 *
 * 在 Session 交接时由 LLM 生成，注入新 Session 上下文。
 * 双重存储：Session handoffSummary（交接用）+ memory_entries（检索用）。
 */
export interface SessionHandoffSummary {
  conversationId: string;
  sessionSequence: number; // 第几个 Session
  keyDecisions: string[]; // 关键决策
  pendingTasks: string[]; // 待完成任务
  activeContext: string; // 当前工作上下文
  participantStatus: Record<string, string>; // 参与者状态
}

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
  handoffSummary: SessionHandoffSummary | null; // 从前序 Session 继承的交接摘要（B-CS-3）
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
 * 构造新 active Session 的纯工厂（F20260805rsto）。
 * CreateOtter（首世建账）与 ManageSession.createSession（重启/交接建链）共用，
 * 避免两处各自拼装 session 对象导致字段漂移。
 */
export function buildNewSession(
  otterId: string,
  previousSessionId: string | null,
  summary: string | null = null,
): OtterSession {
  return {
    id: crypto.randomUUID(),
    otterId,
    status: "active",
    previousSessionId,
    startedAt: new Date().toISOString(),
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary,
    handoffSummary: null,
  };
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
