import type { OtterSession, SessionHandoffSummary } from "@entities/otter/otter-session";
import {
  canArchiveSession,
  archiveReasonToSessionStatus,
} from "@entities/otter/otter-session";
import type { MemoryLayer } from "@entities/memory/memory-entry";
import type { OtterRepository } from "./otter-repository";
import type { AgentGateway } from "./agent-gateway";

/** Gateway: 查询 otter 关联的对话 ID（由 main.ts 装配 ManageConversation 实现） */
export interface ConversationQueryGateway {
  getIdsByOtterId(otterId: string): Promise<string[]>;
}

/** Gateway: 更新对话的活跃 Session 绑定（D-ARCH-1，由 main.ts 装配 ManageConversation 实现） */
export interface ConversationBindingGateway {
  updateActiveSessionId(
    conversationId: string,
    sessionId: string | null,
  ): Promise<void>;
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
    private readonly conversationBinding: ConversationBindingGateway,
  ) {}

  /**
   * 创建新 Session。
   * 前置条件：该 otter 无 active session。
   * previousSessionId 指向前一个 session（链式关系，B14）。
   */
  async createSession(otterId: string): Promise<OtterSession> {
    /** 前置条件检查：不允许同时存在两个 active session */
    const activeSession = await this.repo.getActiveSession(otterId);
    if (activeSession) {
      throw new Error(
        `Otter ${otterId} already has an active session: ${activeSession.id}`,
      );
    }

    /** 查询历史以获取前一个 session（链式关系） */
    const history = await this.repo.getSessionHistory(otterId);
    const previousSessionId = history.length > 0 ? history[0].id : null;

    const session: OtterSession = {
      id: crypto.randomUUID(),
      otterId,
      status: "active",
      previousSessionId,
      startedAt: new Date().toISOString(),
      archivedAt: null,
      archiveReason: null,
      isNegativeCase: false,
      summary: null,
      handoffSummary: null,
    };

    await this.repo.createSession(session);
    return session;
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    return this.repo.getActiveSession(otterId);
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
    /** 1. 查询 session */
    const session = await this.repo.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    /** 2. 不变量校验 */
    if (!canArchiveSession(session.status)) {
      throw new Error(
        `Session is not active: ${sessionId} (status=${session.status})`,
      );
    }

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

    /** 6. Agent reset（重置上下文） */
    await this.agentGateway.reset(session.otterId);

    return {
      ...session,
      status: targetStatus,
      archivedAt,
      archiveReason: params.reason,
      isNegativeCase: params.isNegativeCase,
      summary: params.summary ?? null,
    };
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    return this.repo.getSessionHistory(otterId);
  }

  /**
   * Session 交接（B-CS-1, B-CS-2, B-CS-3）。
   *
   * 原子操作：归档当前 Session -> 创建新 Session -> 存储交接摘要 -> 更新对话绑定 -> Agent reset。
   * 交接摘要双重存储：Session handoffSummary（交接用）+ memory_entries（检索用，由调用方负责）。
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
    /** 1. 归档当前 Session（状态更新 + 工作记忆转历史） */
    const archivedSession = await this.archiveSession(sessionId, {
      reason,
      isNegativeCase: false,
    });

    /** 2. 创建新 Session（链式关系） */
    const newSession = await this.createSession(archivedSession.otterId);

    /** 3. 存储交接摘要到新 Session */
    await this.repo.setHandoffSummary(newSession.id, handoffSummary);

    /** 4. 更新对话绑定（activeSessionId -> 新 Session） */
    const conversationIds = await this.conversationQuery.getIdsByOtterId(
      archivedSession.otterId,
    );
    for (const conversationId of conversationIds) {
      await this.conversationBinding.updateActiveSessionId(
        conversationId,
        newSession.id,
      );
    }

    /** 5. Agent reset，注入交接摘要作为上下文（B-CS-3） */
    await this.agentGateway.reset(archivedSession.otterId, {
      context: { handoffSummary },
    });

    return {
      archivedSession,
      newSession: { ...newSession, handoffSummary },
    };
  }
}
