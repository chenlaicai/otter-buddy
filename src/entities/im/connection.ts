/** 连接状态 */
export type ConnectionStatus = "active" | "inactive";

/** Connection 实体：飞书群在系统中的代理 */
export interface Connection {
  id: string;
  name: string;
  externalId: string;
  externalType: string;
  metadata: Record<string, unknown> | null;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

/** 连接会话状态 */
export type ConnectionSessionStatus = "active" | "released";

/** ConnectionSession 实体：Connection 与 Conversation 的绑定 */
export interface ConnectionSession {
  id: string;
  connectionId: string;
  conversationId: string;
  status: ConnectionSessionStatus;
  joinedAt: string;
  releasedAt: string | null;
}

/**
 * Connection 是否处于活跃状态。
 */
export function isActiveConnection(status: ConnectionStatus): boolean {
  return status === "active";
}

/**
 * ConnectionSession 是否处于活跃状态。
 */
export function isActiveSession(status: ConnectionSessionStatus): boolean {
  return status === "active";
}

/**
 * 验证 Connection 名称是否合法。
 */
export function isValidConnectionName(name: string): boolean {
  return name.trim().length > 0 && name.length <= 200;
}

/**
 * 验证 externalId 是否合法。
 */
export function isValidExternalId(externalId: string): boolean {
  return externalId.trim().length > 0;
}
