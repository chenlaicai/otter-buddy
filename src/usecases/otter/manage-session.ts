import type { OtterSession } from "@entities/otter/otter-session";
import {
  canArchiveSession,
  archiveReasonToSessionStatus,
  buildNewSession,
} from "@entities/otter/otter-session";
import type { MemoryLayer } from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";
import type { Logger } from "@usecases/ports/logger";

/** Gateway: 查询 otter 关联的对话 ID（由 main.ts 装配 ManageConversation 实现） */
export interface ConversationQueryGateway {
  getIdsByOtterId(otterId: string): Promise<string[]>;
}

/** Gateway: 记忆层转换（由 main.ts 装配 ManageMemory 实现） */
export interface MemoryLayerGateway {
  updateLayer(
    conversationId: string,
    from: MemoryLayer,
    to: MemoryLayer,
  ): Promise<void>;
}

export interface ArchiveSessionInput {
  reason: string;
  isNegativeCase: boolean;
  summary?: string;
}

export class ManageSession {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentGateway: AgentGateway,
    private readonly conversationQuery: ConversationQueryGateway,
    private readonly memoryLayer: MemoryLayerGateway,
    private readonly logger: Logger,
  ) {}

  /**
   * 创建新 Session。
   * 前置条件：该 otter 无 active session。
   * previousSessionId 指向前一个 session（链式关系，B14）。
   * summary（F20260805rsto）：写入新行，供下一轮 invoke 注入新獭生上下文
   * （restart 的「前情摘要」原本只写旧行，新 session 永远读不到）。
   */
  async createSession(
    otterId: string,
    params?: { summary?: string },
  ): Promise<OtterSession> {
    /** 前置条件检查：不允许同时存在两个 active session */
    const activeSession = await this.repo.getActiveSession(otterId);
    if (activeSession) {
      throw new DomainError(
        `Otter ${otterId} already has an active session: ${activeSession.id}`,
        "conflict",
      );
    }

    /** 查询历史以获取前一个 session（链式关系） */
    const history = await this.repo.getSessionHistory(otterId);
    const previousSessionId = history.length > 0 ? history[0].id : null;

    const session = buildNewSession(otterId, previousSessionId, params?.summary ?? null);

    await this.repo.createSession(session);

    // 记录 Session 创建日志
    this.logger.info('Session created', {
      otterId,
      sessionId: session.id,
      previousSessionId,
      action: 'create',
    });

    return session;
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    return this.repo.getActiveSession(otterId);
  }

  /** 更新 session 摘要（F20260805rsto：restart 竞态认领既有新行时补写前情） */
  async setSessionSummary(sessionId: string, summary: string): Promise<void> {
    await this.repo.setSessionSummary(sessionId, summary);
  }

  /**
   * 归档 Session（完整业务操作）。
   * 含：状态更新 + 工作记忆转历史 + Agent reset。
   * 通过 Gateway 接口调用跨上下文能力，不直接依赖 conversation/memory 上下文。
   */
  async archiveSession(
    sessionId: string,
    params: ArchiveSessionInput,
  ): Promise<OtterSession> {
    const { session, targetStatus, archivedAt } =
      await this.archiveSessionCore(sessionId, params);

    /** Agent reset（重置上下文） */
    await this.agentGateway.reset(session.otterId);

    // 记录 Session 归档日志
    this.logger.info('Session archived', {
      otterId: session.otterId,
      sessionId,
      reason: params.reason,
      isNegativeCase: params.isNegativeCase,
      action: 'archive',
    });

    return {
      ...session,
      status: targetStatus,
      archivedAt,
      archiveReason: params.reason,
      isNegativeCase: params.isNegativeCase,
      summary: params.summary ?? null,
    };
  }

  /**
   * 归档核心逻辑（不含 Agent reset）。
   * 提取为独立方法，供 archiveSession 内部组合（reset 在其后统一执行）。
   */
  private async archiveSessionCore(
    sessionId: string,
    params: ArchiveSessionInput,
  ) {
    /** 1. 查询 session */
    const session = await this.repo.getSessionById(sessionId);
    if (!session) {
      throw new DomainError(`Session not found: ${sessionId}`, "not_found");
    }

    /** 2. 不变量校验 */
    if (!canArchiveSession(session.status)) {
      throw new DomainError(
        `Session is not active: ${sessionId} (status=${session.status})`,
        "validation",
      );
    }

    /** 保存归档前状态（用于回滚） */
    const originalStatus = session.status;

    /** 3. 计算目标状态（B3/B4 回归守护） */
    const targetStatus = archiveReasonToSessionStatus(params.reason);
    const archivedAt = new Date().toISOString();

    /** 4. 更新 session 状态 */
    await this.repo.archiveSession(sessionId, targetStatus, params, archivedAt);

    /** 5. 工作记忆转历史（B10） */
    const conversationIds = await this.conversationQuery.getIdsByOtterId(
      session.otterId,
    );
    for (const conversationId of conversationIds) {
      await this.memoryLayer.updateLayer(
        conversationId,
        "working",
        "historical",
      );
    }

    return { session, targetStatus, archivedAt, conversationIds, originalStatus };
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    return this.repo.getSessionHistory(otterId);
  }
}
