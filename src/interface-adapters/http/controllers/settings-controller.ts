import type { Context } from "hono";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import { USER_DISPLAY_NAME_KEY, MAHJONG_DEFAULT_OTTERS_KEY, parseMahjongDefaultOtters, type MahjongDefaultOtter } from "@usecases/settings/settings-keys";
import { handleError } from "../http-error";
import { safeJsonBody } from "../parse-json-body";
import type { SettingsDTO, UpdateSettingsRequestDTO } from "@contract/api/settings";

/** Settings 系统信息（由 main.ts 注入，只读基线） */
export interface SettingsConfig {
  port: number;
  dbPath: string;
  embeddingModelPath: string;
  /** 本地模型根目录。设置后走本地加载，未设置走远程下载 */
  embeddingLocalModelPath?: string;
  embeddingDim: number;
  /** F20260924wast：浮动獭开关（im.assistant.web.enabled；只读下发——改配置需重启生效） */
  assistantWebEnabled: boolean;
}

/** 默认模型写入函数类型（由 Composition Root 注入，解耦 frameworks 依赖） */
type WriteDefaultModel = (alias: string, modelPool: ModelPoolLike, logger: Logger) => void;

export class SettingsController {
  constructor(
    private readonly settings: SettingsConfig,
    private readonly settingsRepo: SettingsRepository,
    private readonly modelPool: ModelPoolLike,
    private readonly logger: Logger,
    private readonly writeDefaultModel: WriteDefaultModel,
  ) {}

  private buildDTO(userName: string, defaultOtters: MahjongDefaultOtter[]): SettingsDTO {
    return {
      ...this.settings,
      models: this.modelPool.getModelInfos(),
      defaultModelAlias: this.modelPool.getDefaultAlias(),
      userName,
      defaultOtters,
    };
  }

  async getSettings(c: Context): Promise<Response> {
    try {
      const userName = (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY)) ?? '';
      const defaultOtters = parseMahjongDefaultOtters(await this.settingsRepo.get(MAHJONG_DEFAULT_OTTERS_KEY)) ?? [];
      return c.json(this.buildDTO(userName, defaultOtters));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async updateSettings(c: Context): Promise<Response> {
    try {
      const body = await safeJsonBody<UpdateSettingsRequestDTO>(c);
      if (body.defaultModelAlias) {
        if (!this.modelPool.hasModel(body.defaultModelAlias)) {
          return c.json({ error: `未知模型 alias: ${body.defaultModelAlias}` }, 400);
        }
        // Why: config.yaml 是默认模型的唯一真相源，不再写 DB settings 表
        this.writeDefaultModel(body.defaultModelAlias, this.modelPool, this.logger);
        this.modelPool.setDefaultAlias(body.defaultModelAlias);
        this.logger.info("Default model switched", { defaultModelAlias: body.defaultModelAlias });
      }
      if (body.userName !== undefined) {
        const cleaned = body.userName.replace(/[\r\n]/g, '').trim();
        if (cleaned.length > 32) {
          return c.json({ error: "名字不能超过 32 个字符" }, 400);
        }
        await this.settingsRepo.update(USER_DISPLAY_NAME_KEY, cleaned);
        this.logger.info("User display name updated", { userName: cleaned });
      }
      if (body.defaultOtters !== undefined) {
        const err = this.validateDefaultOtters(body.defaultOtters);
        if (err) return c.json({ error: err }, 400);
        await this.settingsRepo.update(MAHJONG_DEFAULT_OTTERS_KEY, JSON.stringify(body.defaultOtters));
        this.logger.info('Mahjong default otters updated', { count: body.defaultOtters.length });
      }
      const userName = (await this.settingsRepo.get(USER_DISPLAY_NAME_KEY)) ?? '';
      const defaultOtters = parseMahjongDefaultOtters(await this.settingsRepo.get(MAHJONG_DEFAULT_OTTERS_KEY)) ?? [];
      return c.json(this.buildDTO(userName, defaultOtters));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** F20261022mjls：默认陪打獭入参校验（自 updateSettings 拆出——控复杂度）；通过返回 null */
  private validateDefaultOtters(raw: unknown): string | null {
    if (!Array.isArray(raw)) return 'defaultOtters 必须是 [{otterId, name}] 数组';
    for (const item of raw) {
      const rec = item as Partial<MahjongDefaultOtter>;
      if (typeof rec?.otterId !== 'string' || !rec.otterId || typeof rec?.name !== 'string' || !rec.name) {
        return 'defaultOtters 每项需含非空 otterId 与 name';
      }
    }
    return null;
  }
}
