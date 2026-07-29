import type { Connection, ConnectionSession, ConnectionStatus } from "@entities/im/connection";

export interface ConnectionRepository {
  // Connection CRUD
  create(connection: Connection): Promise<void>;
  getById(id: string): Promise<Connection | null>;
  getByExternalId(externalId: string): Promise<Connection | null>;
  listActive(): Promise<Connection[]>;
  updateStatus(id: string, status: ConnectionStatus, timestamp: string): Promise<void>;

  // Session 管理
  getActiveSession(connectionId: string): Promise<ConnectionSession | null>;
  getActiveSessionByConversation(conversationId: string): Promise<ConnectionSession | null>;
  createSession(session: ConnectionSession): Promise<void>;
  releaseSession(sessionId: string, releasedAt: string): Promise<void>;

  // 历史查询
  getSessionHistory(connectionId: string, limit?: number): Promise<ConnectionSession[]>;
}
