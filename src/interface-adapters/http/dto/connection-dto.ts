import type { Connection, ConnectionSession } from "@entities/im/connection";
// F20261023cnct：契约类型迁 @contract/api/connection（issue #1063 契约同步），
// 本文件仅保留实体→DTO 映射函数（映射属 HTTP 层职责，非契约本身）。
// CreateConnectionRequestDTO 随死端点 POST /api/connections 下线删除。
export type {
  ConnectionDTO,
  ConnectionSessionDTO,
  EnterConversationRequestDTO,
} from "@contract/api/connection";
import type { ConnectionDTO, ConnectionSessionDTO } from "@contract/api/connection";

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
