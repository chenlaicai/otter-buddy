import type { Context } from "hono";

/** Settings 配置值（由 main.ts 注入） */
export interface SettingsConfig {
  provider: string;
  model: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  embeddingDim: number;
}

export class SettingsController {
  constructor(
    private readonly settings: SettingsConfig,
  ) {}

  async getSettings(c: Context): Promise<Response> {
    return c.json(this.settings);
  }
}
