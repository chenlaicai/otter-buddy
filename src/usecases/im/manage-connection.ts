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
  async createConnection(name: string, externalId: string, externalType = "feishu"): Promise<Connection> {
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
      // F20260831xtrt：通道类型可声明（weixin 等）；缺省 feishu 保持既有行为
      externalType,
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

  /** 首次见到的外部用户/群自动注册为 Connection（备用方法）
   *  F20260831xtrt：externalType 透传 createConnection，微信 ingress 传 "weixin" */
  async ensureConnection(externalId: string, name: string, externalType = "feishu"): Promise<Connection> {
    const existing = await this.connRepo.getByExternalId(externalId);
    if (existing) {
      return existing;
    }

    return this.createConnection(name, externalId, externalType);
  }

  /** Connection 进入 Conversation（核心操作，使用事务解决竞态条件） */
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

    // 3. 检查是否已在目标 conversation 中
    const oldSession = await this.connRepo.getActiveSession(connectionId);
    if (oldSession && oldSession.conversationId === conversationId) {
      return oldSession; // 已经在目标 conversation 中，直接返回
    }

    // 4. 使用事务执行进入操作（解决竞态条件）
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const newSession: ConnectionSession = {
      id,
      connectionId,
      conversationId,
      status: "active",
      joinedAt: now,
      releasedAt: null,
    };

    try {
      await this.connRepo.enterConversationTransaction(
        connectionId,
        conversationId,
        oldSession?.id ?? null,
        newSession,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("already occupied")) {
        throw new DomainError(err.message, "conflict");
      }
      throw err;
    }

    this.logger.info('Connection entered conversation', {
      connectionId,
      conversationId,
      sessionId: id,
    });

    return newSession;
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

  /** 列出所有 active Conversation（供 /list 命令，优化 N+1 查询） */
  async listActiveConversations(): Promise<Array<{ id: string; title: string; occupiedBy?: string }>> {
    const conversationIds = await this.convRepo.getAllIds({ limit: 100 });
    if (conversationIds.length === 0) return [];

    // 批量查询 conversations
    const conversations = await Promise.all(
      conversationIds.map(id => this.convRepo.getById(id))
    );
    const activeConversations = conversations.filter(
      (c): c is NonNullable<typeof c> => c !== null && c.status === "active"
    );

    if (activeConversations.length === 0) return [];

    // 批量查询 sessions
    const activeConvIds = activeConversations.map(c => c.id);
    const sessions = await this.connRepo.getActiveSessionsByConversations(activeConvIds);

    // 批量查询 connections
    const connectionIds = [...new Set(sessions.map(s => s.connectionId))];
    const connections = connectionIds.length > 0
      ? await this.connRepo.getByIds(connectionIds)
      : [];
    const connectionMap = new Map(connections.map(c => [c.id, c.name]));

    // 组装结果
    const sessionMap = new Map(sessions.map(s => [s.conversationId, s]));
    return activeConversations.map(conv => {
      const session = sessionMap.get(conv.id);
      return {
        id: conv.id,
        title: conv.title,
        occupiedBy: session ? connectionMap.get(session.connectionId) : undefined,
      };
    });
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

  /** 根据 Conversation ID 获取活跃的 Session */
  async getSessionByConversation(conversationId: string): Promise<ConnectionSession | null> {
    return this.connRepo.getActiveSessionByConversation(conversationId);
  }
}
