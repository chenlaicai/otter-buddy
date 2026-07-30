import type Database from "better-sqlite3";
import type { Connection, ConnectionSession, ConnectionStatus } from "@entities/im/connection";
import type { ConnectionRepository } from "@usecases/im/connection-repository";

interface ConnectionRow {
  id: string;
  name: string;
  external_id: string;
  external_type: string;
  metadata: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ConnectionSessionRow {
  id: string;
  connection_id: string;
  conversation_id: string;
  status: string;
  joined_at: string;
  released_at: string | null;
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    externalId: row.external_id,
    externalType: row.external_type,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    status: row.status as ConnectionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: ConnectionSessionRow): ConnectionSession {
  return {
    id: row.id,
    connectionId: row.connection_id,
    conversationId: row.conversation_id,
    status: row.status as "active" | "released",
    joinedAt: row.joined_at,
    releasedAt: row.released_at,
  };
}

export class SqliteConnectionRepository implements ConnectionRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Connection CRUD ──

  async create(connection: Connection): Promise<void> {
    this.db.prepare(`
      INSERT INTO connections (id, name, external_id, external_type, metadata, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      connection.id,
      connection.name,
      connection.externalId,
      connection.externalType,
      connection.metadata ? JSON.stringify(connection.metadata) : null,
      connection.status,
      connection.createdAt,
      connection.updatedAt,
    );
  }

  async getById(id: string): Promise<Connection | null> {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
    return row ? rowToConnection(row) : null;
  }

  async getByExternalId(externalId: string): Promise<Connection | null> {
    const row = this.db.prepare(
      "SELECT * FROM connections WHERE external_id = ? AND status = 'active'"
    ).get(externalId) as ConnectionRow | undefined;
    return row ? rowToConnection(row) : null;
  }

  async listActive(): Promise<Connection[]> {
    const rows = this.db.prepare(
      "SELECT * FROM connections WHERE status = 'active' ORDER BY created_at DESC"
    ).all() as ConnectionRow[];
    return rows.map(rowToConnection);
  }

  async updateStatus(id: string, status: ConnectionStatus, timestamp: string): Promise<void> {
    this.db.prepare(
      "UPDATE connections SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, timestamp, id);
  }

  // ── Session 管理 ──

  async getActiveSession(connectionId: string): Promise<ConnectionSession | null> {
    const row = this.db.prepare(
      "SELECT * FROM connection_sessions WHERE connection_id = ? AND status = 'active'"
    ).get(connectionId) as ConnectionSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async getActiveSessionByConversation(conversationId: string): Promise<ConnectionSession | null> {
    const row = this.db.prepare(
      "SELECT * FROM connection_sessions WHERE conversation_id = ? AND status = 'active'"
    ).get(conversationId) as ConnectionSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async createSession(session: ConnectionSession): Promise<void> {
    this.db.prepare(`
      INSERT INTO connection_sessions (id, connection_id, conversation_id, status, joined_at, released_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.connectionId,
      session.conversationId,
      session.status,
      session.joinedAt,
      session.releasedAt,
    );
  }

  async releaseSession(sessionId: string, releasedAt: string): Promise<void> {
    this.db.prepare(
      "UPDATE connection_sessions SET status = 'released', released_at = ? WHERE id = ?"
    ).run(releasedAt, sessionId);
  }

  // ── 历史查询 ──

  async getSessionHistory(connectionId: string, limit?: number): Promise<ConnectionSession[]> {
    const rows = this.db.prepare(
      "SELECT * FROM connection_sessions WHERE connection_id = ? ORDER BY joined_at DESC LIMIT ?"
    ).all(connectionId, limit ?? 50) as ConnectionSessionRow[];
    return rows.map(rowToSession);
  }

  // ── 批量查询（优化 N+1 问题） ──

  async getByIds(ids: string[]): Promise<Connection[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM connections WHERE id IN (${placeholders}) AND status = 'active'`
    ).all(...ids) as ConnectionRow[];
    return rows.map(rowToConnection);
  }

  async getActiveSessionsByConversations(conversationIds: string[]): Promise<ConnectionSession[]> {
    if (conversationIds.length === 0) return [];
    const placeholders = conversationIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM connection_sessions WHERE conversation_id IN (${placeholders}) AND status = 'active'`
    ).all(...conversationIds) as ConnectionSessionRow[];
    return rows.map(rowToSession);
  }

  // ── 事务操作（解决竞态条件） ──

  async enterConversationTransaction(
    connectionId: string,
    conversationId: string,
    oldSessionId: string | null,
    newSession: ConnectionSession,
  ): Promise<ConnectionSession> {
    return this.db.transaction(() => {
      // 1. 检查 conversation 是否已被其他 connection 占用
      const existingSession = this.db.prepare(
        "SELECT * FROM connection_sessions WHERE conversation_id = ? AND status = 'active'"
      ).get(conversationId) as ConnectionSessionRow | undefined;

      if (existingSession && existingSession.connection_id !== connectionId) {
        throw new Error(`Conversation ${conversationId} is already occupied by connection ${existingSession.connection_id}`);
      }

      // 2. 释放旧 session（如果有）
      if (oldSessionId) {
        this.db.prepare(
          "UPDATE connection_sessions SET status = 'released', released_at = ? WHERE id = ?"
        ).run(newSession.joinedAt, oldSessionId);
      }

      // 3. 创建新 session
      this.db.prepare(`
        INSERT INTO connection_sessions (id, connection_id, conversation_id, status, joined_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        newSession.id,
        newSession.connectionId,
        newSession.conversationId,
        newSession.status,
        newSession.joinedAt,
        newSession.releasedAt,
      );

      return newSession;
    })();
  }
}
