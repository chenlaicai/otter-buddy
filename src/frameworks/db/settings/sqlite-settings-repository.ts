import type Database from "better-sqlite3";
import type { SettingsRepository } from "@usecases/settings/settings-repository";

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare(
      "SELECT value FROM settings WHERE key = ?",
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async update(key: string, value: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value);
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
