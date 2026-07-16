import type { Otter } from "@entities/otter/otter";
import type {
  OtterSession,
  SessionHandoffSummary,
  SessionStatus,
} from "@entities/otter/otter-session";

/** archiveSession 的参数类型（Repository 层，不含应用关注点） */
export interface ArchiveSessionParams {
  reason: string;
  isNegativeCase: boolean;
  summary?: string;
}

export interface OtterRepository {
  createOtter(otter: Otter): Promise<void>;
  getById(id: string): Promise<Otter | null>;
  getBigOtter(): Promise<Otter | null>;
  dissolve(otterId: string, dissolvedAt: string): Promise<void>;
  deleteOtter(otterId: string): Promise<void>;
  createSession(session: OtterSession): Promise<void>;
  getActiveSession(otterId: string): Promise<OtterSession | null>;
  archiveSession(
    sessionId: string,
    status: SessionStatus,
    params: ArchiveSessionParams,
    archivedAt: string,
  ): Promise<void>;
  getSessionHistory(otterId: string): Promise<OtterSession[]>;
  getSessionById(sessionId: string): Promise<OtterSession | null>;
  setHandoffSummary(
    sessionId: string,
    handoffSummary: SessionHandoffSummary,
  ): Promise<void>;
  /** 回滚归档：恢复 session 到指定状态（用于 handoff 失败回滚） */
  restoreSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void>;
}
