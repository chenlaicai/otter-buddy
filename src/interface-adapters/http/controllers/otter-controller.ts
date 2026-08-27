import type { Context } from "hono";
import { DomainError } from "@entities/errors";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { QueryOtterProfile } from "@usecases/otter/query-otter-profile";
import type { CreateOtterInput } from "@usecases/otter/create-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import { handleError, param } from "../http-error";
import { toOtterDTO, toOtterSessionDTO } from "../dto/otter-dto";
import type { CreateOtterRequestDTO } from "../dto/otter-dto";

export class OtterController {
  // eslint-disable-next-line max-params -- 依赖由 DI 装配，参数数量由依赖决定
  constructor(
    private readonly createOtterUseCase: CreateOtter,
    private readonly dissolveOtterUseCase: DissolveOtter,
    private readonly manageSession: ManageSession,
    private readonly queryOtter: QueryOtter,
    private readonly logger: Logger,
    /** 可选：无注入时 OtterDTO.modelAlias 缺省不返回（老数据/测试场景） */
    private readonly configProvider?: OtterConfigProvider,
    /** 可选：profile 聚合端点（PR-2） */
    private readonly queryOtterProfile?: QueryOtterProfile,
    /** F20260826ucrt：可选——UI 入口 modelAlias 校验（settings-controller hasModel 同层先例）。
     *  可选注入保持测试兼容；大獭工具链不走此 controller，不受影响 */
    private readonly modelPool?: ModelPoolLike,
  ) {}

  async getById(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const otter = await this.queryOtter.getById(id);
      if (!otter) {
        return c.json({ error: "Otter not found" }, 404);
      }
      return c.json(toOtterDTO(otter, this.configProvider?.getConfig(id)?.modelAlias));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async create(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<CreateOtterRequestDTO>();

      /** F20260826ucrt T1：UI 入口 modelAlias 校验（400 附可用列表，措辞与大獭工具链 tool-factory 一致）。
       *  未注入 modelPool 时跳过校验（测试/降级场景），usecase 层缺省走默认模型 */
      if (this.modelPool && body.modelAlias && !this.modelPool.hasModel(body.modelAlias)) {
        const available = this.modelPool.describeModels().map(m => m.alias).join(", ");
        throw new DomainError(
          `[错误] 未知的模型别名「${body.modelAlias}」。可用模型：${available}`,
          "validation",
        );
      }

      /** F20260826ucrt T4：血缘诚实化——不再透传 body.parentOtterId。
       *  UI 创建的小獭没有獭召唤者（召唤者是人类用户），血缘如实落 null（usecase 既有 ?? null 逻辑），
       *  与大獭工具链的「系统注入真实召唤者」（tool-factory.ts，不经此 controller）对齐 */
      const input: CreateOtterInput = {
        name: body.name,
        type: body.type,
        role: body.role,
        modelAlias: body.modelAlias,
        systemPrompt: body.systemPrompt,
        context: body.context,
      };
      const otter = await this.createOtterUseCase.execute(input);
      return c.json(toOtterDTO(otter, this.configProvider?.getConfig(otter.id)?.modelAlias), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async dissolve(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const body: { summary?: string } = await c.req.json().catch(() => ({}));
      await this.dissolveOtterUseCase.execute(id, body.summary);
      return c.json({ status: "dissolved" });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async getSessionHistory(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const sessions = await this.manageSession.getSessionHistory(id);
      return c.json(sessions.map(toOtterSessionDTO));
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  async restart(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      /** F20260805rsto：重启是大獭专属机制，小獭用解散——前端入口已隐藏，后端兜底校验 */
      const otter = await this.queryOtter.getById(id);
      if (otter?.type === "small") {
        throw new DomainError("小獭不支持重启獭生，请使用解散", "validation");
      }
      const body: { summary?: string } = await c.req.json().catch(() => ({}));
      const session = await this.manageSession.restartSession(id, body.summary);
      return c.json(toOtterSessionDTO(session), 201);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** PR-2：聚合 profile 端点（装备四槽 + 战绩统计） */
  async getProfile(c: Context): Promise<Response> {
    try {
      if (!this.queryOtterProfile) {
        return c.json({ error: "Profile endpoint not configured" }, 501);
      }
      const id = param(c, "id");
      const profile = await this.queryOtterProfile.execute(id);
      return c.json(profile);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}
