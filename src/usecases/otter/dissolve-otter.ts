import { canDissolveOtter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
import type { ManageSession, ArchiveSessionInput } from "./manage-session";

export class DissolveOtter {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
    private readonly manageSession: ManageSession,
  ) {}

  /**
   * 解散 Otter（完整业务操作）。
   * 含：归档 active session（含记忆转换 + Agent reset）+ 状态更新 + Agent 销毁。
   */
  async execute(otterId: string, summary?: string): Promise<void> {
    /** 1. 查询 Otter */
    const otter = await this.repo.getById(otterId);
    if (!otter) {
      throw new DomainError(`Otter not found: ${otterId}`, "not_found");
    }

    /** 2. 不变量校验 */
    if (!canDissolveOtter(otter.status)) {
      throw new DomainError(
        `Cannot dissolve otter with status: ${otter.status}`,
        "validation",
      );
    }

    /** 3. 归档 active session（含记忆层转换 + Agent reset） */
    const activeSession = await this.manageSession.getActiveSession(otterId);
    if (activeSession) {
      const archiveInput: ArchiveSessionInput = {
        reason: "dissolve",
        isNegativeCase: false,
        summary,
      };
      await this.manageSession.archiveSession(activeSession.id, archiveInput);
    }

    /** 4. 更新状态为 dissolved（B5 回归守护） */
    await this.repo.dissolve(otterId, new Date().toISOString());

    /** 5. 销毁 Agent（B5 回归守护） */
    await this.agentGateway.destroy(otterId);
  }
}
