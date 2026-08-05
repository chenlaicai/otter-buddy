import type { Otter, OtterType, OtterRole } from "@entities/otter/otter";
import { buildNewSession } from "@entities/otter/otter-session";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { OtterPromptConfig } from "@contract/api/otter";

export interface CreateOtterInput {
  name: string;
  type: OtterType;
  role?: OtterRole;
  parentOtterId?: string;
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
  ) {}

  async execute(params: CreateOtterInput): Promise<Otter> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const otter: Otter = {
      id,
      name: params.name,
      type: params.type,
      status: "active",
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
     */
    try {
      await this.repo.createSession(buildNewSession(id, null));
      this.logger.info('Session created', { otterId: id, action: 'create' });
    } catch (err) {
      /**
       * 回滚顺序不可颠倒：先 destroy agent，再 deleteOtter。
       * FK 约束 otter_sessions.otter_id REFERENCES otters(id)（foreign_keys=ON），
       * 若 session 行已落库而先删 otter 会 FK 违规；
       * 此处 createSession 为单条 INSERT（原子），失败即无行，故无需 deleteSession。
       */
      try {
        await this.agentGateway.destroy(id);
      } catch { /* 回滚尽力而为，不掩盖原始错误 */ }
      await this.repo.deleteOtter(id);
      throw err;
    }

    return otter;
  }
}
