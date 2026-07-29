import { DomainError } from "@entities/errors";
import type { Connection, ConnectionSession } from "@entities/im/connection";
import { isActiveConnection, isValidConnectionName, isValidExternalId } from "@entities/im/connection";
import type { ConnectionRepository } from "./connection-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";

export class ManageConnection {
  constructor(
    private readonly connRepo: ConnectionRepository,
    private readonly convRepo: ConversationRepository,
    private readonly logger: Logger,
  ) {}

  /** 创建新连接（手动绑定） */
  async createConnection(name: string, externalId: string): Promise<Connection> {
    if (!isValidConnectionName(name)) {
      throw new DomainError("Connection name must be non-empty and <= 200 characters", "validation");
    }
    if (!isValidExternalId(externalId)) {
      throw new DomainError("External ID must be non-empty", "validation");
    }

    // 检查 externalId 是否已存在
    const existing = await this.connRepo.getByExternalId(externalId);
    if (existing) {
      throw new DomainError(`Connection with external ID ${externalId} already exists`, "conflict");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const connection: Connection = {
      id,
      name,
      externalId,
      externalType: "feishu",
      metadata: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    await this.connRepo.create(connection);

    this.logger.info('Connection created', {
      connectionId: id,
      name,
      externalId,
    });

    return connection;
  }

  /** 首次见到的飞书群自动注册为 Connection（备用方法） */
  async ensureConnection(externalId: string, name: string): Promise<Connection> {
    const existing = await this.connRepo.getByExternalId(externalId);
    if (existing) {
      return existing;
    }

    return this.createConnection(name, externalId);
  }

  /** Connection 进入 Conversation（核心操作） */
  async enterConversation(connectionId: string, conversationId: string): Promise<ConnectionSession> {
    // 1. 校验 connection 存在且 active
    const connection = await this.connRepo.getById(connectionId);
    if (!connection) {
      throw new DomainError(`Connection not found: ${connectionId}`, "not_found");
    }
    if (!isActiveConnection(connection.status)) {
      throw new DomainError(`Connection ${connectionId} is not active`, "validation");
    }

    // 2. 校验 conversation 存在且 active
    const conversation = await this.convRepo.getById(conversationId);
    if (!conversation) {
      throw new DomainError(`Conversation not found: ${conversationId}`, "not_found");
    }
    if (conversation.status !== "active") {
      throw new DomainError(`Conversation ${conversationId} is not active`, "validation");
    }

    // 3. 检查该 conversation 是否已被其他 connection 占用
    const existingSession = await this.connRepo.getActiveSessionByConversation(conversationId);
    if (existingSession && existingSession.connectionId !== connectionId) {
      throw new DomainError(
        `Conversation ${conversationId} is already occupied by connection ${existingSession.connectionId}`,
        "conflict"
      );
    }

    // 4. 释放该 connection 的旧 active session（如有）
    const oldSession = await this.connRepo.getActiveSession(connectionId);
    if (oldSession) {
      if (oldSession.conversationId === conversationId) {
        // 已经在目标 conversation 中，直接返回
        return oldSession;
      }
      await this.connRepo.releaseSession(oldSession.id, new Date().toISOString());
    }

    // 5. 创建新 session
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const session: ConnectionSession = {
      id,
      connectionId,
      conversationId,
      status: "active",
      joinedAt: now,
      releasedAt: null,
    };

    await this.connRepo.createSession(session);

    this.logger.info('Connection entered conversation', {
      connectionId,
      conversationId,
      sessionId: id,
    });

    return session;
  }

  /** Connection 离开当前 Conversation */
  async leaveConversation(connectionId: string): Promise<void> {
    const session = await this.connRepo.getActiveSession(connectionId);
    if (!session) {
      throw new DomainError(`Connection ${connectionId} is not in any conversation`, "validation");
    }

    await this.connRepo.releaseSession(session.id, new Date().toISOString());

    this.logger.info('Connection left conversation', {
      connectionId,
      conversationId: session.conversationId,
    });
  }

  /** 列出所有 active Conversation（供 /list 命令） */
  async listActiveConversations(): Promise<Array<{ id: string; title: string; occupiedBy?: string }>> {
    const conversationIds = await this.convRepo.getAllIds({ limit: 100 });
    const result: Array<{ id: string; title: string; occupiedBy?: string }> = [];

    for (const id of conversationIds) {
      const conversation = await this.convRepo.getById(id);
      if (!conversation || conversation.status !== "active") {
        continue;
      }

      const session = await this.connRepo.getActiveSessionByConversation(id);
      let occupiedBy: string | undefined;
      if (session) {
        const connection = await this.connRepo.getById(session.connectionId);
        occupiedBy = connection?.name;
      }

      result.push({
        id: conversation.id,
        title: conversation.title,
        occupiedBy,
      });
    }

    return result;
  }

  /** 获取 Connection 当前绑定的 Conversation */
  async getCurrentConversation(connectionId: string): Promise<{ id: string; title: string } | null> {
    const session = await this.connRepo.getActiveSession(connectionId);
    if (!session) {
      return null;
    }

    const conversation = await this.convRepo.getById(session.conversationId);
    if (!conversation) {
      return null;
    }

    return {
      id: conversation.id,
      title: conversation.title,
    };
  }

  /** 获取 Connection 信息 */
  async getConnection(connectionId: string): Promise<Connection | null> {
    return this.connRepo.getById(connectionId);
  }

  /** 列出所有 Connection */
  async listConnections(): Promise<Connection[]> {
    return this.connRepo.listActive();
  }
}
