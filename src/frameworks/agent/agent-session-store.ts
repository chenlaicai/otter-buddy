import type Database from "better-sqlite3";

/**
 * 管理 otter_id ↔ pi_session_id 映射（agent_sessions 表）。
 * 独立于 OtterRepository：pi_session_id 是 frameworks-internal 数据，不属于 Otter 实体。
 */
export class AgentSessionStore {
  constructor(private readonly db: Database.Database) {}

  set(otterId: string, piSessionId: string): void {
    this.db.prepare(`
      INSERT INTO agent_sessions (otter_id, pi_session_id, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(otter_id) DO UPDATE SET
        pi_session_id = excluded.pi_session_id,
        updated_at = excluded.updated_at
    `).run(otterId, piSessionId);
  }

  get(otterId: string): string | null {
    const row = this.db.prepare(
      "SELECT pi_session_id FROM agent_sessions WHERE otter_id = ?",
    ).get(otterId) as { pi_session_id: string } | undefined;
    return row?.pi_session_id ?? null;
  }

  delete(otterId: string): void {
    this.db.prepare("DELETE FROM agent_sessions WHERE otter_id = ?").run(otterId);
  }

  update(otterId: string, newPiSessionId: string): void {
    this.db.prepare(`
      UPDATE agent_sessions SET pi_session_id = ?, updated_at = datetime('now')
      WHERE otter_id = ?
    `).run(newPiSessionId, otterId);
  }

  setWithFile(otterId: string, piSessionId: string, sessionFile: string): void {
    this.db.prepare(`
      INSERT INTO agent_sessions (otter_id, pi_session_id, session_file, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(otter_id) DO UPDATE SET
        pi_session_id = excluded.pi_session_id,
        session_file = excluded.session_file,
        updated_at = excluded.updated_at
    `).run(otterId, piSessionId, sessionFile);
  }

  getWithFile(otterId: string): { piSessionId: string; sessionFile: string } | null {
    const row = this.db.prepare(
      "SELECT pi_session_id, session_file FROM agent_sessions WHERE otter_id = ?"
    ).get(otterId) as { pi_session_id: string; session_file: string } | undefined;
    return row ? { piSessionId: row.pi_session_id, sessionFile: row.session_file } : null;
  }

  updateWithFile(otterId: string, newPiSessionId: string, sessionFile: string): void {
    this.db.prepare(`
      UPDATE agent_sessions SET pi_session_id = ?, session_file = ?, updated_at = datetime('now')
      WHERE otter_id = ?
    `).run(newPiSessionId, sessionFile, otterId);
  }

  updateSessionFile(otterId: string, sessionFile: string): void {
    this.db.prepare(`
      UPDATE agent_sessions SET session_file = ?, updated_at = datetime('now')
      WHERE otter_id = ?
    `).run(sessionFile, otterId);
  }
}

/** 工厂函数：创建 AgentSessionStore */
export function createAgentSessionStore(db: Database.Database): AgentSessionStore {
  return new AgentSessionStore(db);
}
