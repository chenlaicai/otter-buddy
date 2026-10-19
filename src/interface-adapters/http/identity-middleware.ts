import type { Context, Next } from "hono";

/**
 * #1322 对话域 HTTP 鉴权层：身份声明解析 + 路由级策略表 + fail-closed 兜底。
 * F20261016autz。
 *
 * 定位（特性文档取舍③）：这是**声明式身份接缝**，不是凭据校验——头/query 可被蓄意伪造者
 * 构造。防线价值：① 挡裸 URL/链接预取/忘带凭据的误访；② 强制自定义头 ⇒ 浏览器跨站
 * 简单请求（表单 POST 等 CSRF 面）必先 preflight，服务未开 CORS 即被拦；③ 给未来
 * session/凭据体系一个挂点——值源从常量换成 session 派生即升级，策略表与调用面不动。
 * 凭据绑定属 session 工程（#1322 非目标），本层是接缝不是终态。
 *
 * 策略表**顺序敏感**（首条命中）：public 面 → 族内例外（write/须先于 admin 族规则）→ admin 族。
 * 表外 `/api/*` 走方法级兜底：GET/HEAD/OPTIONS → authenticated、其余 → write（fail-closed——
 * 直击「新端点忘配策略表」的扩散根因，见 issue #1322 评论「新增面」：三麻九端点即为活例）。
 * 非 `/api/*`（静态/SPA/metrics）不在本域，直通。
 */

/** 身份档位（高→低）。单用户自部署现状：web 前端与运维脚本声明 admin，档位表为多用户/session 预留 */
export type Role = "admin" | "user" | "guest";
/** 路由策略档位：public=免身份 / authenticated=须身份 / write=身份+≥user / admin=身份+admin */
export type Policy = "public" | "authenticated" | "write" | "admin";

export interface Identity {
  userId: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { guest: 0, user: 1, admin: 2 };

/** 身份 id 允许字符（A-Za-z0-9 _ . : @ -），1..128——不合规则视同未声明（401 fail-closed） */
const ID_PATTERN = /^[\w.:@-]{1,128}$/;

/** 身份传输通道：请求头（首选）；直链场景（img/audio/a href 设不了头）退化为 query 参数 */
export const IDENTITY_HEADERS = { userId: "X-Otter-User-Id", role: "X-Otter-User-Role" } as const;
export const IDENTITY_QUERY = { userId: "otterUserId", role: "otterRole" } as const;

interface PolicyRule {
  /** 不填 = 全方法 */
  methods?: readonly string[];
  path: RegExp;
  policy: Policy;
  /** 表即安全态势文档：每条给出归属与理由 */
  note?: string;
}

/**
 * 路由级策略表（#1322 修复方向：X-Otter 身份头中间件 + 路由级策略表）。
 * 新增路由：先想清楚落哪档——忘写也兜底（GET→authenticated、非 GET→write），但显式列出才是文档。
 */
export const POLICY_TABLE: readonly PolicyRule[] = [
  // ── public ──
  {
    path: /^\/api\/inbound(\/|$)/,
    policy: "public",
    note: "平台回调（微信/ilink）无法携带我方身份头——其校验责任在 inbound 面既有机制，#1322 范围外（验签缺口留档，见特性文档「已知残留」）",
  },
  {
    path: /^\/api\/mahjong(\/|$)/,
    policy: "public",
    note: "issue #1322 评论「新增面」：**暂置** public——并行分支 fix/mahjong-chat-echo 未接身份头，强启会打断牌局页。翻转条件：web-mahjong 前端接入 identityHeaders 后按 L2 选型（issue 评论①②③）收紧为 read/write",
  },
  // ── 族内例外（必须先于同族 admin 规则命中）──
  { methods: ["POST"], path: /^\/api\/otters\/[^/]+\/retry$/, policy: "write", note: "会话重试=用户级交互，非建散重启" },
  { methods: ["POST"], path: /^\/api\/connections\/[^/]+\/(enter|leave)$/, policy: "write", note: "IM 进出会话=用户级交互，非通道凭据注册" },
  { methods: ["POST"], path: /^\/api\/memory\/search\/similar$/, policy: "authenticated", note: "语义是检索（POST 形态的读），不按写兜底" },
  // ── admin（建散/凭据/自动化/配置等系统级写）──
  { methods: ["POST", "DELETE"], path: /^\/api\/otters(\/|$)/, policy: "admin", note: "建獭/解散/重启" },
  {
    path: /^\/api\/settings(\/|$)/,
    policy: "admin",
    note: "配置读写全档收 admin（**含 GET 读面**——dbPath/模型路径属基础设施信息，收紧优先；消费方 web UI/健康探针均声明 admin 档，无降档需要，#1541 首轮检视处置 1）",
  },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/scheduled-tasks(\/|$)/, policy: "admin", note: "定时任务增改删+立即触发（服务器侧自动化）" },
  { methods: ["POST"], path: /^\/api\/conversations\/[^/]+\/scheduled-tasks$/, policy: "admin", note: "会话级定时任务创建" },
  { methods: ["POST"], path: /^\/api\/health\/(scan|signals)/, policy: "admin", note: "体检扫描与 healing 信号处置" },
  { methods: ["POST", "DELETE"], path: /^\/api\/connections(\/|$)/, policy: "admin", note: "通道（微信/飞书 ilink）注册" },
  {
    methods: ["POST", "PATCH", "DELETE"],
    path: /^\/api\/(weixin|feishu)(\/|$)/,
    policy: "admin",
    note: "平台凭据/账号面写（含 accounts/lookup——凭据页操作按 admin 计，见特性文档取舍）",
  },
];

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v !== "" ? v : undefined;
}

function isRole(v: string): v is Role {
  return v === "admin" || v === "user" || v === "guest";
}

/** 解析方法+路径的策略档位（导出供测试直击矩阵） */
export function resolvePolicy(method: string, path: string): Policy {
  if (!path.startsWith("/api/")) return "public"; // 静态/SPA/metrics 不在鉴权域
  const m = method.toUpperCase();
  for (const rule of POLICY_TABLE) {
    if (rule.methods && !rule.methods.includes(m)) continue;
    if (rule.path.test(path)) return rule.policy;
  }
  // fail-closed 兜底：读须身份，非读至少 user——新端点忘配策略也落入鉴权
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "authenticated" : "write";
}

/** 解析身份声明：头优先、query 退路（附件直链）；id 非法视同缺失，role 非法/缺失降级 guest。
 *  通道整体性：任一身份头在场 ⇒ 整体走头通道、query 不参与（防 URL 参数越权上抬角色——
 *  query 会进日志/Referrer，不得与头混通道）；两通道皆无才走 query 直链退路。 */
export function parseIdentity(c: Context): Identity | null {
  const headerId = nonEmpty(c.req.header(IDENTITY_HEADERS.userId));
  const headerRole = nonEmpty(c.req.header(IDENTITY_HEADERS.role));
  const anyHeader = headerId !== undefined || headerRole !== undefined;
  const userId = anyHeader ? headerId : nonEmpty(c.req.query(IDENTITY_QUERY.userId));
  if (!userId || !ID_PATTERN.test(userId)) return null;
  const rawRole = anyHeader ? headerRole : nonEmpty(c.req.query(IDENTITY_QUERY.role));
  const role: Role = rawRole !== undefined && isRole(rawRole) ? rawRole : "guest";
  return { userId, role };
}

function deny(c: Context, status: 401 | 403, error: string, code: "unauthorized" | "forbidden"): Response {
  return c.json({ error, code }, status);
}

/** 挂在 router 最外层（requestId 之后）：一处覆盖全部既有与新增路由 */
export function identityMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const policy = resolvePolicy(c.req.method, c.req.path);
    if (policy === "public") {
      await next();
      return;
    }
    const identity = parseIdentity(c);
    if (!identity) return deny(c, 401, "Authentication required", "unauthorized");
    // 下游控制器可读身份（接缝已就位；当前无消费方——session 工程的挂点）
    c.set("identity" as never, identity);
    if (policy === "authenticated") {
      await next();
      return;
    }
    const required: Role = policy === "admin" ? "admin" : "user";
    if (ROLE_RANK[identity.role] < ROLE_RANK[required]) {
      return deny(c, 403, `Insufficient role: ${policy} requires ${required}`, "forbidden");
    }
    await next();
  };
}
