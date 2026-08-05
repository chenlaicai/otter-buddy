import type { Otter } from "@entities/otter/otter";
import type {
  OtterSession,
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
  /** 更新 session 摘要（F20260805rsto：restart 竞态认领既有新行时补写前情） */
  setSessionSummary(sessionId: string, summary: string): Promise<void>;
}
