import type { Connection, ConnectionSession } from "@entities/im/connection";

export interface ConnectionDTO {
  id: string;
  name: string;
  externalId: string;
  externalType: string;
  metadata: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionSessionDTO {
  id: string;
  connectionId: string;
  conversationId: string;
  status: string;
  joinedAt: string;
  releasedAt: string | null;
}

export interface CreateConnectionRequestDTO {
  name: string;
  externalId: string;
}

export interface EnterConversationRequestDTO {
  conversationId: string;
}

export function toConnectionDTO(connection: Connection): ConnectionDTO {
  return {
    id: connection.id,
    name: connection.name,
    externalId: connection.externalId,
    externalType: connection.externalType,
    metadata: connection.metadata,
    status: connection.status,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function toConnectionSessionDTO(session: ConnectionSession): ConnectionSessionDTO {
  return {
    id: session.id,
    connectionId: session.connectionId,
    conversationId: session.conversationId,
    status: session.status,
    joinedAt: session.joinedAt,
    releasedAt: session.releasedAt,
  };
}
