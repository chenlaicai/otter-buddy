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
      /** F20260904schf P2（#792）：dissolve 出站清算——该獭已发出、tsp 指向
       *  active 目标但从未记账的信号槽位，补 aborted 墓碑（发言人已不存在，
       *  信号永不派发；不补则永久 pending，僵尸信号）。可选注入，失败仅日志。 */
      abortUnattemptedOutgoing?: (otterId: string) => Promise<number>;
      logger?: { warn(message: string, context?: Record<string, unknown>): void };
    },
  ) {}

  /**
   * 解散 Otter（完整业务操作）。
   * 含：归档 active session（含记忆转换 + Agent reset）+ 状态更新 + Agent 销毁。
   * 复杂度控制：两段清账副作用抽私有方法（settlePendingDispatches / abortOutgoingSignals）。
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

    /** 4.5/4.6 信号台账双面清账（均失败仅日志，不阻断主流程） */
    await this.settlePendingDispatches(otterId);
    await this.abortOutgoingSignals(otterId);

    /** 5. 销毁 Agent（B5 回归守护） */
    await this.agentGateway.destroy(otterId);
  }

  /** 4.5 F20260903dmpe 阻尼#4：dissolve 事务内销账名下 in_progress 派发——
   *  行动人已不存在，其 in_progress 永无 settle 来源（孤儿账）。落 failed 终态
   *  与 pendingClause 的 dissolved 过滤双保险（09-03 事故的场景根治）。
   *  失败仅日志：账面清理不阻断 dissolve 主流程。 */
  private async settlePendingDispatches(otterId: string): Promise<void> {
    if (!this.deps?.settlePendingForOtter) return;
    try {
      const settled = await this.deps.settlePendingForOtter(otterId);
      if (settled > 0) {
        this.deps.logger?.warn(`[signal-ledger] dissolve 翻篇：已解散獭名下 in_progress 派发落 failed`, { otterId, settled });
      }
    } catch (e) {
      this.deps.logger?.warn('[signal-ledger] dissolve 销账失败（不阻断解散）', { otterId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 4.6 F20260904schf P2（#792）：dissolve 出站清算——该獭发出的 completed 消息，
   *  tsp 指向 active 目标且从未记账的槽位补 aborted/dissolve 墓碑。发言人已解散，
   *  其 yield 信号永不派发；不补则 pendingClause（sender 不限 dissolved）会把这些
   *  槽位永久算 pending（僵尸信号，本次事故的弹药库残余）。
   *  与 4.5 的分工：4.5 清【入站】in_progress 孤儿账；4.6 清【出站】从未记账的裸槽位。
   *  失败仅日志：账面清理不阻断 dissolve 主流程。 */
  private async abortOutgoingSignals(otterId: string): Promise<void> {
    if (!this.deps?.abortUnattemptedOutgoing) return;
    try {
      const aborted = await this.deps.abortUnattemptedOutgoing(otterId);
      if (aborted > 0) {
        this.deps.logger?.warn(`[signal-ledger] dissolve 出站清算：已解散獭的未派发信号补 aborted 墓碑`, { otterId, aborted });
      }
    } catch (e) {
      this.deps.logger?.warn('[signal-ledger] dissolve 出站清算失败（不阻断解散）', { otterId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
