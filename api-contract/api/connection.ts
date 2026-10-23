// F20261023cnct：IM 连接管理存活端点契约（GET /api/connections/:id、POST /api/connections/:id/enter、
// GET /api/connections/:id/conversations）。自后端 dto/connection-dto.ts 与 web/src/api/client.ts
// 双端各自定义迁入单一真相源（issue #1063 api-contract 契约同步），消除双端 DTO 漂移面。
// 注意：CreateConnectionRequestDTO 随死端点 POST /api/connections 下线删除，不迁入。

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

export interface EnterConversationRequestDTO {
  conversationId: string;
}

export interface ActiveConversationDTO {
  id: string;
  title: string;
  occupiedBy?: string;
}
