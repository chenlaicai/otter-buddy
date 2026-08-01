import type { Otter, OtterType, OtterRole } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
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

    return otter;
  }
}
