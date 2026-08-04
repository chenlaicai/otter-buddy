import type { Context } from "hono";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Logger } from "@usecases/ports/logger";
import { handleError } from "../http-error";
import type { UpdateSettingsRequestDTO } from "@contract/api/settings";

/** Settings 配置值（由 main.ts 注入，只读基线） */
export interface SettingsConfig {
  provider: string;
  model: string;
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  /** 本地模型根目录。设置后走本地加载，未设置走远程下载 */
  embeddingLocalModelPath?: string;
  embeddingDim: number;
}

export class SettingsController {
  constructor(

    private readonly settings: SettingsConfig,
    private readonly settingsRepo: SettingsRepository,
      private readonly logger: Logger,
  ) {}

  async getSettings(c: Context): Promise<Response> {
    try {
      const stored = await this.settingsRepo.getAll();
      return c.json({
        ...this.settings,
        provider: stored.provider ?? this.settings.provider,
        model: stored.model ?? this.settings.model,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async updateSettings(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<UpdateSettingsRequestDTO>();
      if (body.provider) {
        await this.settingsRepo.update("provider", body.provider);
      }
      if (body.model) {
        await this.settingsRepo.update("model", body.model);
      }
      const stored = await this.settingsRepo.getAll();
      return c.json({
        ...this.settings,
        provider: stored.provider ?? this.settings.provider,
        model: stored.model ?? this.settings.model,
      });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
