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
  groupId: string | null;
  supersededBy: string | null;
  /** F20261013csv3 T2：unfurl_cache 读侧 join 投影（join 键 resource.url ↔
   *  unfurl_cache.url）——PR 卡 diff stat + 状态徽章数据源。仅 url 类型资源、
   * 且缓存命中 github-api 记录时携带；落空为 null（渲染侧显示「未抓取」态）。 */
  unfurl?: {
    source: "og" | "github-api" | "failed";
    title: string | null;
    description: string | null;
    error: string | null;
    additions: number | null;
    deletions: number | null;
  } | null;
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
