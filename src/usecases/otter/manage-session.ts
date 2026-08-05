import type { OtterSession, SessionHandoffSummary } from "@entities/otter/otter-session";
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

/** Session 交接结果 */
export interface HandoffResult {
  archivedSession: OtterSession;
  newSession: OtterSession;
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
   * 提取为独立方法供 handoffSession 复用，避免双重 reset。
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

  /**
   * Session 交接（B-CS-1, B-CS-2, B-CS-3）。
   *
   * 原子操作：归档当前 Session -> 创建新 Session -> 存储交接摘要 -> Agent reset。
   * 交接摘要双重存储：Session handoffSummary（交接用）+ memory_entries（检索用，由调用方负责）。
   *
   * 错误回滚：若 createSession / setHandoffSummary 失败，
   * 回滚归档状态和记忆层转换；Agent reset 延到最后一步执行，失败前可安全回滚。
   *
   * @param sessionId - 当前活跃 Session 的 ID
   * @param handoffSummary - 由 LLM 生成的结构化交接摘要
   * @param reason - 交接原因（如 "token_threshold", "user指令"）
   */
  async handoffSession(
    sessionId: string,
    handoffSummary: SessionHandoffSummary,
    reason: string,
  ): Promise<HandoffResult> {
    /** 1. 归档当前 Session（不含 Agent reset，由最后一步统一执行） */
    const { session, targetStatus, archivedAt, conversationIds, originalStatus } =
      await this.archiveSessionCore(sessionId, {
        reason,
        isNegativeCase: false,
      });

    const archivedSession: OtterSession = {
      ...session,
      status: targetStatus,
      archivedAt,
      archiveReason: reason,
      isNegativeCase: false,
      summary: null,
    };

    /** 2. 创建新 Session（链式关系） */
    let newSession: OtterSession;
    try {
      newSession = await this.createSession(archivedSession.otterId);
    } catch (e) {
      await this.rollbackArchive(session, originalStatus, conversationIds);
      throw e;
    }

    /** 3. 存储交接摘要到新 Session */
    try {
      await this.repo.setHandoffSummary(newSession.id, handoffSummary);
    } catch (e) {
      await this.rollbackArchive(session, originalStatus, conversationIds, newSession.id);
      throw e;
    }

    /** 4. Agent reset，注入交接摘要作为上下文（B-CS-3）——最后执行，不可回滚 */
    await this.agentGateway.reset(archivedSession.otterId, {
      context: { handoffSummary },
    });

    return {
      archivedSession,
      newSession: { ...newSession, handoffSummary },
    };
  }

  /** 回滚归档：恢复 session 状态 + 记忆层转换 + 清理僵尸新 Session */
  private async rollbackArchive(
    session: OtterSession,
    originalStatus: OtterSession["status"],
    conversationIds: string[],
    newSessionId?: string,
  ) {
    await this.repo.restoreSessionStatus(session.id, originalStatus);
    if (newSessionId) {
      await this.repo.deleteSession(newSessionId);
    }
    for (const conversationId of conversationIds) {
      await this.memoryLayer.updateLayer(
        conversationId,
        "historical",
        "working",
      );
    }
  }
}
