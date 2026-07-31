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
