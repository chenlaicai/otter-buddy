import type { Otter, OtterType, OtterRole } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { buildNewSession } from "@entities/otter/otter-session";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { OtterPromptConfig } from "@contract/api/otter";
// F20260908efmd: 首世建账时快照有效模型
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import { resolveEffectiveModel } from "@usecases/ports/otter-config-provider";
import { pickOtterColor } from "@entities/otter/palette-picking";
import { OTTER_PALETTE_KEYS } from "@contract/api/otter-palette";

export interface CreateOtterInput {
  name: string;
  type: OtterType;
  role?: OtterRole;
  parentOtterId?: string;
  /** F20260921otcl：出生挑色域——对话 ID。type='small' 时查对话内 active 小獭已用色
   *  挑未占用色板 key 落 otters.color；大獭/无此字段不分配（NULL）。控制器与
   *  tool-factory 均持有 conversationId，由调用方注入 */
  conversationId?: string;
  /** Otter 级系统提示词（可选，与平台 prompt 叠加） */
  systemPrompt?: string | OtterPromptConfig;
  context?: Record<string, unknown>;
  /** 模型别名（多模型路由，可选） */
  modelAlias?: string;
}

export class CreateOtter {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
    private readonly logger: Logger,
    /** F20260908efmd: 可选——用于首世建账时解析有效模型。未注入时首世 modelAlias 不快照 */
    private readonly otterConfigProvider?: OtterConfigProvider,
    /** F20260908efmd: 可选——用于首世建账时解析有效模型。未注入时首世 modelAlias 不快照 */
    private readonly modelPool?: ModelPoolLike,
  ) {}

  async execute(params: CreateOtterInput): Promise<Otter> {
    // #891 对抗审视发现 1：null body 经 safeJsonBody 兜底 {} 后 name/type 为 undefined，
    // 无校验透传会撞 DB NOT NULL 约束 → 500 且回显表结构（otters.name）——此处前置 validation
    if (typeof params.name !== "string" || params.name.trim().length === 0) {
      throw new DomainError("name 必填且为非空字符串", "validation");
    }
    if (typeof params.type !== "string" || params.type.trim().length === 0) {
      throw new DomainError("type 必填且为非空字符串", "validation");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const color = await this.allocateBirthColor(params);

    const otter: Otter = {
      id,
      name: params.name,
      type: params.type,
      status: "active",
      color,
      role: params.role ?? null,
      parentOtterId: params.parentOtterId ?? null,
      createdAt: now,
      dissolvedAt: null,
    };

    /** 1. 写入 DB */
    await this.repo.createOtter(otter);

    /** 2. 创建 Agent 实例（传递 otterType 到 context，确保工具过滤正确） */
    try {
      await this.agentGateway.create(id, {
        systemPrompt: params.systemPrompt,
        context: { ...params.context, otterType: params.type },
        modelAlias: params.modelAlias,
      });
    } catch (err) {
      /** B1 回归守护：Agent 创建失败时回滚 DB 记录，避免孤立 Otter */
      await this.repo.deleteOtter(id);
      throw err;
    }

    /**
     * 3. 建首世 domain session（F20260805rsto）。
     * 不变量：「有 agent 会话 ⟹ 有 active domain session」。獭出生即建账，
     * restart/dissolve 的 archive 前置条件（存在 active session）恒真。
     * 直接用 repo + 实体工厂而非注入 ManageSession——避免
     * CreateOtter → ManageSession → ManageConversation → CreateOtter 组装环。
     * F20260908efmd: 首世建账时快照有效模型（params.modelAlias ?? 默认模型）。
     */
    try {
      // F20260908efmd: 首世必须显式传值——解析后的 effective model alias
      const sessionModelAlias = this.resolveModelForFirstSession(otter.id, params.modelAlias);
      await this.repo.createSession(buildNewSession(id, null, null, sessionModelAlias));
      this.logger.info('Session created', { otterId: id, action: 'create' });
    } catch (err) {
      /**
       * 回滚顺序不可颠倒：先 destroy agent，再 deleteOtter。
       * agent_sessions.otter_id REFERENCES otters(id) 且 foreign_keys=ON——
       * 不 destroy 就 deleteOtter 会 FK 违规，回滚自身抛错、双残留。
       * （createSession 是单条原子 INSERT，失败即无 session 行，故无需 deleteSession。）
       */
      try {
        await this.agentGateway.destroy(id);
      } catch { /* 回滚尽力而为，不掩盖原始错误 */ }
      await this.repo.deleteOtter(id);
      throw err;
    }

    return otter;
  }

  /**
   * F20260921otcl：出生挑色——小獭 + 有对话域时，查对话内占用集挑未占用色。
   *  全占用挑占用最少（并列取色板 index 最小，pickOtterColor 内实现）；
   *  大獭与异常路径（无 conversationId）落 NULL，前端展示回退承接。
   *  挑色失败不阻断创建（颜色是展示属性非业务依赖）——NULL + 展示回退
   */
  private async allocateBirthColor(params: CreateOtterInput): Promise<string | null> {
    if (params.type !== "small" || !params.conversationId) return null;
    try {
      const occupied = await this.repo.getColorOccupancy(params.conversationId);
      return pickOtterColor(OTTER_PALETTE_KEYS, occupied);
    } catch (err) {
      this.logger.warn("Otter color allocation failed (non-fatal)", {
        conversationId: params.conversationId, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * F20260908efmd: 解析首世建账的有效模型。
   * 与 ManageSession.resolveModelForSession 逻辑一致，但调用方自行解析
   * （避免组装环 CreateOtter → ManageSession）。
   */
  private resolveModelForFirstSession(otterId: string, explicitAlias?: string): string | null {
    if (explicitAlias) return explicitAlias;
    if (!this.otterConfigProvider || !this.modelPool) return null;
    const config = this.otterConfigProvider.getConfig(otterId);
    return resolveEffectiveModel(config, this.modelPool).alias;
  }
}
