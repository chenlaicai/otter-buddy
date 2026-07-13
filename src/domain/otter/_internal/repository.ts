/**
 * SQLite 持久化：otters + otter_sessions 表 CRUD。
 *
 * 使用 better-sqlite3 同步 API，外键约束已启用。
 */

import type Database from "better-sqlite3";
import type { Otter, OtterSession, CreateOtterInput, ArchiveSessionInput } from "../model";
import { rowToOtter, rowToSession, type OtterRow, type SessionRow } from "./mapper";

export class OtterRepository {
  constructor(private readonly db: Database.Database) {}

  createOtter(id: string, input: CreateOtterInput): Otter {
    const stmt = this.db.prepare(`
      INSERT INTO otters (id, name, type, status, role_name, role_responsibilities, parent_otter_id)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `);

    const roleName = input.roleName ?? null;
    const responsibilities = input.roleResponsibilities
      ? JSON.stringify(input.roleResponsibilities)
      : null;

    stmt.run(id, input.name, input.type, roleName, responsibilities, input.parentOtterId ?? null);

    return this.getById(id)!;
  }

  getById(id: string): Otter | null {
    const row = this.db.prepare("SELECT * FROM otters WHERE id = ?").get(id) as OtterRow | undefined;
    return row ? rowToOtter(row) : null;
  }

  getBigOtter(): Otter | null {
    const row = this.db.prepare(
      "SELECT * FROM otters WHERE type = 'big' AND status = 'active' LIMIT 1",
    ).get() as OtterRow | undefined;
    return row ? rowToOtter(row) : null;
  }

  dissolve(otterId: string): void {
    this.db.prepare(`
      UPDATE otters SET status = 'dissolved', dissolved_at = datetime('now')
      WHERE id = ?
    `).run(otterId);
  }

  createSession(otterId: string): OtterSession {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO otter_sessions (id, otter_id, status)
      VALUES (?, ?, 'active')
    `).run(id, otterId);

    const row = this.db.prepare("SELECT * FROM otter_sessions WHERE id = ?").get(id) as SessionRow;
    return rowToSession(row);
  }

  getActiveSession(otterId: string): OtterSession | null {
    const row = this.db.prepare(`
      SELECT * FROM otter_sessions
      WHERE otter_id = ? AND status = 'active'
      LIMIT 1
    `).get(otterId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  archiveSession(sessionId: string, params: ArchiveSessionInput): void {
    /** reason='restart' -> status='restarted'，其余 -> 'archived' */
    const status = params.reason === "restart" ? "restarted" : "archived";
    const isNegativeCase = params.isNegativeCase ? 1 : 0;

    this.db.prepare(`
      UPDATE otter_sessions
      SET status = ?, archived_at = datetime('now'),
          archive_reason = ?, is_negative_case = ?, summary = ?
      WHERE id = ?
    `).run(status, params.reason, isNegativeCase, params.summary ?? null, sessionId);
  }

  getSessionHistory(otterId: string): OtterSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM otter_sessions
      WHERE otter_id = ?
      ORDER BY started_at DESC
    `).all(otterId) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** 查找 session（供 adapter 在 archiveSession 时查询 otterId） */
  getSessionById(sessionId: string): OtterSession | null {
    const row = this.db.prepare("SELECT * FROM otter_sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }
}
