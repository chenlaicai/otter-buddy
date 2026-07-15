import type Database from "better-sqlite3";

/**
 * 管理 otter_id ↔ pi_session_id 映射（agent_sessions 表）。
 * 独立于 OtterRepository：pi_session_id 是 frameworks-internal 数据，不属于 Otter 实体。
 */
export class AgentSessionStore {
  constructor(private readonly db: Database.Database) {}

  set(otterId: string, piSessionId: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_sessions (otter_id, pi_session_id, updated_at)
      VALUES (?, ?, datetime('now'))
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
}

/** 工厂函数：创建 AgentSessionStore */
export function createAgentSessionStore(db: Database.Database): AgentSessionStore {
  return new AgentSessionStore(db);
}
