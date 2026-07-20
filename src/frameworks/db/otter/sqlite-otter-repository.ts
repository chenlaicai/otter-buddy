import type Database from "better-sqlite3";
import type { Otter } from "@entities/otter/otter";
import type {
  OtterSession,
  SessionHandoffSummary,
  SessionStatus,
} from "@entities/otter/otter-session";
import type {
  ArchiveSessionParams,
  OtterRepository,
} from "@usecases/otter/otter-repository";
import { rowToOtter, rowToSession, type OtterRow, type SessionRow } from "./otter-mapper";

export class SqliteOtterRepository implements OtterRepository {
  constructor(private readonly db: Database.Database) {}

  async createOtter(otter: Otter): Promise<void> {
    const roleName = otter.role?.name ?? null;
    const responsibilities = otter.role?.responsibilities
      ? JSON.stringify(otter.role.responsibilities)
      : null;

    this.db.prepare(`
      INSERT INTO otters (id, name, type, status, role_name, role_responsibilities, parent_otter_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      otter.id,
      otter.name,
      otter.type,
      otter.status,
      roleName,
      responsibilities,
      otter.parentOtterId,
      otter.createdAt,
    );
  }

  async getById(id: string): Promise<Otter | null> {
    const row = this.db.prepare("SELECT * FROM otters WHERE id = ?").get(id) as OtterRow | undefined;
    return row ? rowToOtter(row) : null;
  }

  async dissolve(otterId: string, dissolvedAt: string): Promise<void> {
    this.db.prepare(`
      UPDATE otters SET status = 'dissolved', dissolved_at = ?
      WHERE id = ?
    `).run(dissolvedAt, otterId);
  }

  async deleteOtter(otterId: string): Promise<void> {
    this.db.prepare("DELETE FROM otters WHERE id = ?").run(otterId);
  }

  async createSession(session: OtterSession): Promise<void> {
    this.db.prepare(`
      INSERT INTO otter_sessions (id, otter_id, status, previous_session_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.otterId,
      session.status,
      session.previousSessionId,
      session.startedAt,
    );
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    const row = this.db.prepare(`
      SELECT * FROM otter_sessions
      WHERE otter_id = ? AND status = 'active'
      LIMIT 1
    `).get(otterId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async archiveSession(
    sessionId: string,
    status: SessionStatus,
    params: ArchiveSessionParams,
    archivedAt: string,
  ): Promise<void> {
    const isNegativeCase = params.isNegativeCase ? 1 : 0;

    this.db.prepare(`
      UPDATE otter_sessions
      SET status = ?, archived_at = ?,
          archive_reason = ?, is_negative_case = ?, summary = ?
      WHERE id = ?
    `).run(status, archivedAt, params.reason, isNegativeCase, params.summary ?? null, sessionId);
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    const rows = this.db.prepare(`
      SELECT * FROM otter_sessions
      WHERE otter_id = ?
      ORDER BY started_at DESC
    `).all(otterId) as SessionRow[];
    return rows.map(rowToSession);
  }

  async getSessionById(sessionId: string): Promise<OtterSession | null> {
    const row = this.db.prepare("SELECT * FROM otter_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async setHandoffSummary(
    sessionId: string,
    handoffSummary: SessionHandoffSummary,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE otter_sessions SET handoff_summary = ? WHERE id = ?
    `).run(JSON.stringify(handoffSummary), sessionId);
  }

  async restoreSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE otter_sessions SET status = ?, archived_at = NULL, archive_reason = NULL WHERE id = ?
    `).run(status, sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.prepare(`DELETE FROM otter_sessions WHERE id = ?`).run(sessionId);
  }
}
