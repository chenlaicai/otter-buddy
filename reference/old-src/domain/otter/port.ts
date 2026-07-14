/**
 * OtterPort：domain/otter 唯一的公开接口。
 *
 * 方法行为参见 F20260713o4t8 设计文档。
 * OtterPort 不暴露 Agent 执行方法（sendMessage/getResponse），
 * 执行由 app/agent-runtime 通过 AgentRegistry 直接操作。
 */

import type {
  ArchiveSessionInput,
  CreateOtterInput,
  Otter,
  OtterSession,
} from "./model";

export interface OtterPort {
  // --- Otter 生命周期（数据 + Agent） ---

  /** 创建 Otter 记录 + Agent 实例。不加载 tools（由 app/agent-runtime 编排） */
  create(params: CreateOtterInput): Promise<Otter>;

  /** 按 ID 查询 Otter（纯数据查询） */
  getById(id: string): Promise<Otter | null>;

  /** 获取大獭。未找到时 throw（系统不变量） */
  getBigOtter(): Promise<Otter>;

  /** 解散 Otter：标记 dissolved + 销毁 Agent。session 归档由 app/orchestration 编排 */
  dissolve(otterId: string): Promise<void>;

  // --- Session 生命周期（数据 + Agent reset） ---

  /** 新建 session 记录（status='active'）。Agent 实例不变 */
  createSession(otterId: string): Promise<OtterSession>;

  /** 获取活跃 session（纯数据查询） */
  getActiveSession(otterId: string): Promise<OtterSession | null>;

  /** 归档 session + 重置 Agent 上下文。status: reason='restart'->'restarted'，其余->'archived' */
  archiveSession(sessionId: string, params: ArchiveSessionInput): Promise<void>;

  /** 返回全部 session（含 active），按开始时间倒序 */
  getSessionHistory(otterId: string): Promise<OtterSession[]>;
}
