import type { Connection, ConnectionSession, ConnectionStatus } from "@entities/im/connection";

export interface ConnectionRepository {
  // Connection CRUD
  create(connection: Connection): Promise<void>;
  getById(id: string): Promise<Connection | null>;
  getByExternalId(externalId: string): Promise<Connection | null>;
  listActive(): Promise<Connection[]>;
  updateStatus(id: string, status: ConnectionStatus, timestamp: string): Promise<void>;
  /** F20260920imax 增量五：合并式更新 metadata（读-改-写原子化在 SQL 侧）——
   *  bot 锚定路由用（lastChatId 随入站消息刷新，出站时定向回复） */
  mergeMetadata(id: string, patch: Record<string, unknown>): Promise<void>;

  // Session 管理
  getActiveSession(connectionId: string): Promise<ConnectionSession | null>;
  getActiveSessionByConversation(conversationId: string): Promise<ConnectionSession | null>;
  createSession(session: ConnectionSession): Promise<void>;
  releaseSession(sessionId: string, releasedAt: string): Promise<void>;

  // 历史查询
  getSessionHistory(connectionId: string, limit?: number): Promise<ConnectionSession[]>;

  // 批量查询（优化 N+1 问题）
  getByIds(ids: string[]): Promise<Connection[]>;
  getActiveSessionsByConversations(conversationIds: string[]): Promise<ConnectionSession[]>;

  // 事务操作（解决竞态条件）
  enterConversationTransaction(
    connectionId: string,
    conversationId: string,
    oldSessionId: string | null,
    newSession: ConnectionSession,
  ): Promise<ConnectionSession>;
}
