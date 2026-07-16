import type Database from "better-sqlite3";
import type { OtterContextRepository } from "@usecases/otter/otter-context-repository";

export class SqliteOtterContextRepository implements OtterContextRepository {
  constructor(private readonly db: Database.Database) {}

  async get(otterId: string, key?: string): Promise<Record<string, string>> {
    if (key) {
      const row = this.db.prepare(
        "SELECT key, value FROM otter_context WHERE otter_id = ? AND key = ?",
      ).get(otterId, key) as { key: string; value: string } | undefined;
      return row ? { [row.key]: row.value } : {};
    }

    const rows = this.db.prepare(
      "SELECT key, value FROM otter_context WHERE otter_id = ?",
    ).all(otterId) as { key: string; value: string }[];
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  async set(otterId: string, key: string, value: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO otter_context (otter_id, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (otter_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(otterId, key, value);
  }

  async delete(otterId: string, key: string): Promise<void> {
    this.db.prepare(
      "DELETE FROM otter_context WHERE otter_id = ? AND key = ?",
    ).run(otterId, key);
  }
}
