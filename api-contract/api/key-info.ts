/** 链接资源 DTO（统一产物模型，resourceType="fact" 为文本类事实）
 *  resourceType 开放字符串，已用值：fact（文本事实）/url（外部链接）/file（文档路径）
 *  /pr/worktree/branch（F 特性产物，三型必带 groupId）/game（F20261021gmbe 游戏内嵌——
 *  url 必须为本应用麻将牌局路由 ^/mahjong/[\\w-]+$ 全匹配，中间栏 ArtifactCard 渲染为
 *  宿主内嵌 iframe 面板；外部 URL 永不内嵌，写入侧 validateGameUrl 硬拒）。
 *  新增资源型须过 F20261021gmbe「后续形态接入契约」论证（语义独立性 vs url 型泛化污染）。 */
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
   * 且缓存命中 github-api 记录时携带；落空为 null（渲染侧显示「未抓取」态）。
   *  字段含 state（PR/issue 状态 open/merged/closed/draft）——与 UnfurlCard 的
   *  UnfurlData.state 同口径，两端不漂移（检视发现 1：投影链丢 state 致前端
   *  退用 title.includes 猜状态）。 */
  unfurl?: {
    source: "og" | "github-api" | "failed";
    title: string | null;
    description: string | null;
    error: string | null;
    state: string | null;
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
