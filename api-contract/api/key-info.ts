/** 链接资源 DTO（统一产物模型，resourceType="fact" 为文本类事实） */
export interface LinkedResourceDTO {
  id: string;
  conversationId: string;
  resourceType: string;
  url: string | null;
  title: string | null;
  content: string | null;
  category: string | null;
  userFlagged: boolean;
  metadata: Record<string, unknown> | null;
  linkedBy: string;
  otterId: string | null;
  autoLinked: boolean;
  createdAt: string;
  status: "active" | "superseded" | "archived";
  linkedAtTurnNumber: number;
  statusChangedAtTurnNumber: number;
  groupId: string | null;
  supersededBy: string | null;
}

/** 关键资源组合 DTO */
export interface KeyInfoDTO {
  resources: LinkedResourceDTO[];
}

/** 链接资源请求 DTO */
export interface LinkResourceRequestDTO {
  resourceType: string;
  url?: string;
  title?: string;
  content?: string;
  category?: string;
  metadata?: Record<string, unknown>;
  linkedBy: string;
  otterId?: string;
  autoLinked: boolean;
  groupId?: string;
}
