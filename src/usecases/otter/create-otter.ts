import type { Otter, OtterType, OtterRole } from "@entities/otter/otter";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";

export interface CreateOtterInput {
  name: string;
  type: OtterType;
  role?: OtterRole;
  parentOtterId?: string;
  systemPrompt: string;
  context?: Record<string, unknown>;
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

    /** 2. 创建 Agent 实例 */
    try {
      await this.agentGateway.create(id, {
        systemPrompt: params.systemPrompt,
        context: params.context,
      });
    } catch (err) {
      /** B1 回归守护：Agent 创建失败时回滚 DB 记录，避免孤立 Otter */
      await this.repo.deleteOtter(id);
      throw err;
    }

    return otter;
  }
}
