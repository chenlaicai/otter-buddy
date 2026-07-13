/**
 * 业务逻辑适配器：实现 OtterPort，编排 data + Agent 操作。
 *
 * 设计要点：
 * - create: INSERT otter + AgentRegistry.create
 * - dissolve: UPDATE otter status + AgentRegistry.destroy
 * - archiveSession: UPDATE session + AgentRegistry.reset
 * - getBigOtter: 找不到时 throw（系统不变量）
 * - 只依赖 AgentRegistry 的生命周期方法，不暴露 AgentHandle
 */

import type { OtterPort } from "../port";
import type {
  ArchiveSessionInput,
  CreateOtterInput,
  Otter,
  OtterSession,
} from "../model";
import type { OtterRepository } from "./repository";

/** Agent 生命周期管理接口（AgentRegistry 的子集，避免暴露 AgentHandle） */
export interface AgentLifecyclePort {
  create(
    otterId: string,
    config: { systemPrompt?: string; context?: string },
  ): unknown;
  destroy(otterId: string): void;
  reset(otterId: string, context?: string): void;
}

export class OtterAdapter implements OtterPort {
  constructor(
    private readonly repo: OtterRepository,
    private readonly agentLifecycle: AgentLifecyclePort,
  ) {}

  async create(params: CreateOtterInput): Promise<Otter> {
    const id = crypto.randomUUID();
    const otter = this.repo.createOtter(id, params);

    /** 创建 Agent 实例（不加载 tools，由 app/agent-runtime 编排） */
    try {
      this.agentLifecycle.create(id, {
        systemPrompt: params.systemPrompt,
        context: params.context,
      });
    } catch (err) {
      /** Agent 创建失败：回滚 DB 记录，避免不一致状态 */
      this.repo.deleteOtter(id);
      throw err;
    }

    return otter;
  }

  async getById(id: string): Promise<Otter | null> {
    return this.repo.getById(id);
  }

  async getBigOtter(): Promise<Otter> {
    const otter = this.repo.getBigOtter();
    if (!otter) {
      throw new Error("Big Otter not found");
    }
    return otter;
  }

  async dissolve(otterId: string): Promise<void> {
    const otter = await this.getById(otterId);
    if (!otter) {
      throw new Error(`Otter not found: ${otterId}`);
    }
    this.repo.dissolve(otterId);
    this.agentLifecycle.destroy(otterId);
  }

  async createSession(otterId: string): Promise<OtterSession> {
    return this.repo.createSession(otterId);
  }

  async getActiveSession(otterId: string): Promise<OtterSession | null> {
    return this.repo.getActiveSession(otterId);
  }

  async archiveSession(
    sessionId: string,
    params: ArchiveSessionInput,
  ): Promise<void> {
    /** 先查询 session 获取 otterId，用于 Agent reset */
    const session = this.repo.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error(`Session is not active: ${sessionId} (status=${session.status})`);
    }

    this.repo.archiveSession(sessionId, params);
    this.agentLifecycle.reset(session.otterId);
  }

  async getSessionHistory(otterId: string): Promise<OtterSession[]> {
    return this.repo.getSessionHistory(otterId);
  }
}
