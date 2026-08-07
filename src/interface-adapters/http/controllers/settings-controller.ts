import type { Context } from "hono";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import { DEFAULT_MODEL_ALIAS_KEY, USER_DISPLAY_NAME_KEY } from "@usecases/settings/settings-keys";
import { handleError } from "../http-error";
import type { SettingsDTO, UpdateSettingsRequestDTO } from "@contract/api/settings";

/** Settings 系统信息（由 main.ts 注入，只读基线） */
export interface SettingsConfig {
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
    private readonly modelPool: ModelPoolLike,
    private readonly logger: Logger,
  ) {}

  private buildDTO(userName: string): SettingsDTO {
    return {
      ...this.settings,
      models: this.modelPool.getModelInfos(),
      defaultModelAlias: this.modelPool.getDefaultAlias(),
      userName,
    };
  }

  async getSettings(c: Context): Promise<Response> {
    try {
      const userName = (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY)) ?? '';
      return c.json(this.buildDTO(userName));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async updateSettings(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<UpdateSettingsRequestDTO>();
      if (body.defaultModelAlias) {
        if (!this.modelPool.hasModel(body.defaultModelAlias)) {
          return c.json({ error: `未知模型 alias: ${body.defaultModelAlias}` }, 400);
        }
        await this.settingsRepo.update(DEFAULT_MODEL_ALIAS_KEY, body.defaultModelAlias);
        this.modelPool.setDefaultAlias(body.defaultModelAlias);
        this.logger.info("Default model switched via settings", { defaultModelAlias: body.defaultModelAlias });
      }
      if (body.userName !== undefined) {
        const cleaned = body.userName.replace(/[\r\n]/g, '').trim();
        if (cleaned.length > 32) {
          return c.json({ error: "名字不能超过 32 个字符" }, 400);
        }
        await this.settingsRepo.update(USER_DISPLAY_NAME_KEY, cleaned);
        this.logger.info("User display name updated", { userName: cleaned });
      }
      const userName = (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY)) ?? '';
      return c.json(this.buildDTO(userName));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
