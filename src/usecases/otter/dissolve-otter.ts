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
    private readonly deps?: {
      /** F20260903dmpe 阻尼#4（S4 补丁批）：dissolve 事务内 settle 其 pending——
       *  行动人不存在后，名下 in_progress 派发无主，落 failed 终态（清账侧，
       *  与 pendingClause 的 dissolved 过滤互为哑火/清账两面）。可选注入，失败仅日志。 */
      settlePendingForOtter?: (otterId: string) => Promise<number>;
      logger?: { warn(message: string, context?: Record<string, unknown>): void };
    },
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

    /** 4.5 F20260903dmpe 阻尼#4：dissolve 事务内销账名下 in_progress 派发——
     *  行动人已不存在，其 in_progress 永无 settle 来源（孤儿账）。落 failed 终态
     *  与 pendingClause 的 dissolved 过滤双保险（09-03 事故的场景根治）。
     *  失败仅日志：账面清理不阻断 dissolve 主流程。 */
    if (this.deps?.settlePendingForOtter) {
      try {
        const settled = await this.deps.settlePendingForOtter(otterId);
        if (settled > 0) {
          this.deps.logger?.warn(`[signal-ledger] dissolve 翻篇：已解散獭名下 in_progress 派发落 failed`, { otterId, settled });
        }
      } catch (e) {
        this.deps.logger?.warn('[signal-ledger] dissolve 销账失败（不阻断解散）', { otterId, error: e instanceof Error ? e.message : String(e) });
      }
    }

    /** 5. 销毁 Agent（B5 回归守护） */
    await this.agentGateway.destroy(otterId);
  }
}
