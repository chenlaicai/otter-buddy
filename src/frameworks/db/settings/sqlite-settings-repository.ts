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

  /**
   * 原子插入：仅当 key 不存在时写入 value。
   * 使用 INSERT ... ON CONFLICT DO NOTHING + changes() 实现真正的 CAS。
   * @returns true 如果成功插入（当前进程获得锁），false 如果 key 已存在（另一个进程已抢先）
   */
  async tryInsertIfAbsent(key: string, value: string): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO NOTHING
    `).run(key, value);
    return result.changes > 0;
  }

  /**
   * 原子删除：仅当 key 存在且 value 匹配时删除。
   * 用于清理 stale lock。
   * @returns true 如果成功删除（当前进程获得了锁的所有权），false 如果 value 不匹配（锁已被其他人获取或释放）
   */
  async tryDeleteIfValueMatches(key: string, expectedValue: string): Promise<boolean> {
    const result = this.db.prepare(`
      DELETE FROM settings WHERE key = ? AND value = ?
    `).run(key, expectedValue);
    return result.changes > 0;
  }
}
