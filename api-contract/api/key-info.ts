/** 关键事实 DTO */
export interface KeyFactDTO {
  id: string;
  conversationId: string;
  content: string;
  category: string | null;
  userFlagged: boolean;
  createdBy: string;
  otterId: string | null;
  createdAt: string;
}

/** 链接资源 DTO */
export interface LinkedResourceDTO {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
  status: string;
  linkedAtTurnNumber: number;
  statusChangedAtTurnNumber: number;
  groupId: string | null;
  supersededBy: string | null;
}

/** 关键信息组合 DTO */
export interface KeyInfoDTO {
  keyFacts: KeyFactDTO[];
  linkedResources: LinkedResourceDTO[];
}

/** 添加关键事实请求 DTO */
export interface AddKeyFactRequestDTO {
  content: string;
  category?: string;
  createdBy: string;
  otterId?: string;
}

/** 链接资源请求 DTO */
export interface LinkResourceRequestDTO {
  resourceType: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
  groupId?: string;
}
