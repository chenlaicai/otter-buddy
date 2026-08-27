import type Database from "better-sqlite3";
import type { OtterConfig, OtterConfigProvider, OtterType } from "@usecases/ports/otter-config-provider";
import type { OtterPromptConfig } from "@contract/api/otter";

export class SqliteOtterConfigProvider implements OtterConfigProvider {
  constructor(private readonly db: Database.Database) {}

  getConfig(otterId: string): OtterConfig | null {
    const row = this.db.prepare(
      "SELECT system_prompt, otter_type, model_alias FROM otter_configs WHERE otter_id = ?"
    ).get(otterId) as { system_prompt: string | null; otter_type: string; model_alias: string | null } | undefined;

    if (!row) return null;

    return this.rowToConfig(row);
  }

  /**
   * #446: 单条 IN 查询批量取配置，消除循环内逐个 getConfig 的 N+1。
   * 空数组直接返回空 Map（避免 `IN ()` 语法错）；重复 id 自动去重。
   */
  getConfigs(otterIds: string[]): Map<string, OtterConfig> {
    if (otterIds.length === 0) return new Map();
    const uniqueIds = [...new Set(otterIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT otter_id, system_prompt, otter_type, model_alias FROM otter_configs WHERE otter_id IN (${placeholders})`
    ).all(...uniqueIds) as Array<{ otter_id: string; system_prompt: string | null; otter_type: string; model_alias: string | null }>;

    const result = new Map<string, OtterConfig>();
    for (const row of rows) {
      result.set(row.otter_id, this.rowToConfig(row));
    }
    return result;
  }

  /** 行 → OtterConfig 公共映射（getConfig / getConfigs 共用，避免两份复制粘贴） */
  private rowToConfig(row: { system_prompt: string | null; otter_type: string; model_alias: string | null }): OtterConfig {
    let systemPrompt: string | OtterPromptConfig | undefined;
    if (row.system_prompt) {
      try {
        systemPrompt = JSON.parse(row.system_prompt);
      } catch {
        // JSON 解析失败，返回 undefined
        systemPrompt = undefined;
      }
    }

    return {
      systemPrompt,
      otterType: row.otter_type as OtterType,
      modelAlias: row.model_alias ?? undefined,
    };
  }

  setConfig(otterId: string, config: OtterConfig): void {
    const systemPromptJson = config.systemPrompt ? JSON.stringify(config.systemPrompt) : null;

    this.db.prepare(`
      INSERT INTO otter_configs (otter_id, system_prompt, otter_type, model_alias, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(otter_id) DO UPDATE SET
        system_prompt = excluded.system_prompt,
        otter_type = excluded.otter_type,
        model_alias = excluded.model_alias,
        updated_at = excluded.updated_at
    `).run(otterId, systemPromptJson, config.otterType, config.modelAlias ?? null);
  }

  deleteConfig(otterId: string): void {
    this.db.prepare("DELETE FROM otter_configs WHERE otter_id = ?").run(otterId);
  }

  hasConfig(otterId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM otter_configs WHERE otter_id = ?"
    ).get(otterId);
    return !!row;
  }
}

export function createSqliteOtterConfigProvider(db: Database.Database): OtterConfigProvider {
  return new SqliteOtterConfigProvider(db);
}
