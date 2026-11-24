import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME } from "./auth/session-cookie";
import { isLoopbackAddress } from "./loopback";

/**
 * 对话域 HTTP 鉴权层：身份声明解析 + 路由级策略表 + fail-closed 兜底。
 * 
 *
 * 定位（特性文档取舍③）：这是**声明式身份接缝**，不是凭据校验——头/query 可被蓄意伪造者
 * 构造。因此声明式通道**只在构不成伪造优势的来源上开**:仅本机直连（对端回环且无转发头）。
 * 外部来源只认 owner 会话 cookie（HMAC 签名，不可伪造）；否则一律 401。
 * 经前置反代进来的请求，node 侧看到的对端也是 127.0.0.1——所以判据不能只看对端地址，
 * 转发头（X-Forwarded-For / X-Real-IP / Forwarded）在场即视为外部来源。
 * 防线价值：① 挡裸 URL/链接预取/忘带凭据的误访；② 强制自定义头 ⇒ 浏览器跨站
 * 简单请求（表单 POST 等 CSRF 面）必先 preflight，服务未开 CORS 即被拦；③ 给未来
 * session/凭据体系一个挂点——值源从常量换成 session 派生即升级，策略表与调用面不动。
 * 凭据绑定属 session 工程（非目标），本层是接缝不是终态。
 *
 * 策略表**顺序敏感**（首条命中）：public 面 → 族内例外（write/读面收档/须先于 admin 族规则）→ admin 族。
 * 表外 `/api/*` 走方法级兜底：GET/HEAD/OPTIONS → authenticated、其余 → write（fail-closed——
 * 直击「新端点忘配策略表」的扩散根因：新增面默认有人挡住总比裸奔好）。
 * 但兜底只证「带了某个 id」，guest 也算——业务正文读面（对话清单/时间线/记忆）必须显式列到
 * write 档，不能依赖兜底（那个窗口里 guest 能读全库）。
 * 非 `/api/*`（静态/SPA/metrics）不在本域，直通。
 */

/** 身份档位（高→低）。单用户自部署现状：web 前端与运维脚本声明 admin，档位表为多用户/session 预留。
 *  外部来源的身份只能来自 owner 登录态会话 cookie（声明式头/query 仅本机直连可用）。 */
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
 * 路由级策略表（修复方向：X-Otter 身份头中间件 + 路由级策略表）。
 * 新增路由：先想清楚落哪档——忘写也兜底（GET→authenticated、非 GET→write），但显式列出才是文档。
 */
export const POLICY_TABLE: readonly PolicyRule[] = [
  // ── public ──
  {
    path: /^\/api\/ping$/,
    policy: "public",
    note: "探活端点（阶段 6a）：无身份、零依赖，仅返回进程存活与 uptime——不暴露业务数据；systemd ExecStartPost 与部署脚本健康检查用",
  },
  {
    path: /^\/api\/auth\/(login|logout)$/,
    policy: "public",
    note: "登录/登出端点本身免身份（登录前无会话可提供；登出幂等清 cookie）。session 端点走 GET 兑底 authenticated",
  },
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
  {
    path: /^\/api\/connector\/pair$/,
    policy: "public",
    note: "F20261117cnnct（阶段 4 C1）：connector 配对端点——码即秘密（一次性+时效+原子核销，防探测不区分拒绝原因），connector 是无浏览器进程无登录态；后续需评估配对失败限频",
  },
  {
    methods: ["POST"],
    path: /^\/api\/connector\/pairing-codes$/,
    policy: "admin",
    note: "Web 设备接入签发的是注册执行设备的秘密，只有 owner/admin 可签发；公开核销口不受此规则影响",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/connector\/download$/,
    policy: "write",
    note: "CLI 安装包不含设备秘密，登录 user 即可下载；匿名与 guest 不可读取中枢构建产物",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/connector\/download\/app$/,
    policy: "write",
    note: "可执行安装包（启动器+内嵌运行时+产物）不含设备秘密——与 CLI tarball 同档 user 可下；配对码只经 bootstrap 端点分发",
  },
  {
    methods: ["POST"],
    path: /^\/api\/connector\/download\/bootstrap$/,
    policy: "admin",
    note: "引导文件内嵌一次性配对码（注册设备的秘密）与当前中枢地址——与签发同轨 admin；码的时效/单次核销语义不变，此端点只读验证不核销",
  },
  // ── 族内例外（必须先于同族 admin 规则命中）──
  { methods: ["POST"], path: /^\/api\/otters\/[^/]+\/retry$/, policy: "write", note: "会话重试=用户级交互，非建散重启" },
  // POST :id/leave 已随死端点下线，正则 leave 分支休眠保留（零行为变化，防未来误挂时语义退化）
  { methods: ["POST"], path: /^\/api\/connections\/[^/]+\/(enter|leave)$/, policy: "write", note: "IM 进出会话=用户级交互，非通道凭据注册" },
  { methods: ["POST"], path: /^\/api\/memory\/search\/similar$/, policy: "write", note: "语义是检索（POST 形态的读），但检的是全库记忆正文——按读面同档收口，不按写兜底" },
  // ── 读面显式收档（业务正文读口：guest 不得读，至少 user 档）──
  // 为什么不用兜底 authenticated：兜底只证「带了某个 id」，guest 也算；而对话清单/时间线/记忆
  // 是本系统全部业务数据面，单用户部署里没任何合法 guest 消费方，读它就等于读搭档的全部对话。
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/conversations(\/|$)/,
    policy: "write",
    note: "对话清单与时间线/entries/invokes/附件元数据——业务正文读面。只锁读方法：同族的写/admin 规则仍在下方各自命中（建会话/定时任务/MCP 配置注入）",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/(invokes|entries)(\/|$)/,
    policy: "write",
    note: "invoke 事件流水与时间线条目（带对话 id 的路径在 conversations 族内已有同档规则，此处覆盖顶层直查形态）",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/memory(\/|$)/,
    policy: "write",
    note: "记忆全文/统计/暗化条目——全库私有数据面；与 POST search/similar 同档",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/otters(\/|$)/,
    policy: "write",
    note: "獭详情/画像/session 历史（含交接 summary 与对话上下文），业务正文读面；建散重启仍按下方 admin 规则",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/scheduled-tasks(\/|$)/,
    policy: "write",
    note: "定时任务详情与执行记录——任务 body/指令全文在里面，读它等于读搭档的自动化配置",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/connections(\/|$)/,
    policy: "write",
    note: "通道详情与其活跃对话清单（会话标题/对话 id 的业务别名）——与对话清单同档",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/(skills|prompts)(\/|$)/,
    policy: "write",
    note: "能力库与提示词库全文（内含系统提示词与工具约定），读它等于读系统内部实现",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/(activity|health)(\/|$)/,
    policy: "write",
    note: "体检/自愈/信号/派工台账与工作账本——内部运营数据面（含对话与环境信息）；处置与扫描仍按下方 admin 规则",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/(weixin|feishu|channels|execution-machines)(\/|$)/,
    policy: "write",
    note: "平台账号/通道/执行机清单——基础设施与凭据面元数据，不向低档位开放",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/attachments(\/|$)/,
    policy: "authenticated",
    note: "**保持 authenticated**（显式说明）：附件字节以 <img src>/<audio src> 直链形态消费，身份来自同源会话 cookie；升 write 不增加安全性（能过 cookie 的只能是 owner），却会让任何未登录预览/外链场景直接 403。内容可达性由「知道附件 id」限制（id 为服务端生成的不可枚举标识）",
  },
  {
    methods: ["GET", "HEAD"],
    path: /^\/api\/(auth\/session|unfurl)(\/|$)/,
    policy: "authenticated",
    note: "**保持 authenticated**（显式说明）：session 探活本身要能在未登录时回答「你是谁」，unfurl 只取外部 URL 元信息、不读本地数据面",
  },
  // ── admin（建散/凭据/自动化/配置等系统级写）──
  { methods: ["POST", "DELETE"], path: /^\/api\/otters(\/|$)/, policy: "admin", note: "建獭/解散/重启" },
  {
    path: /^\/api\/settings(\/|$)/,
    policy: "admin",
    note: "配置读写全档收 admin（**含 GET 读面**——dbPath/模型路径属基础设施信息，收紧优先；消费方 web UI/健康探针均声明 admin 档，无降档需要，#1541 首轮检视处置 1）",
  },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/scheduled-tasks(\/|$)/, policy: "admin", note: "定时任务增改删+立即触发（服务器侧自动化）" },
  { methods: ["POST"], path: /^\/api\/conversations\/[^/]+\/scheduled-tasks$/, policy: "admin", note: "会话级定时任务创建" },
  { methods: ["PUT"], path: /^\/api\/conversations\/[^/]+\/workspace\/mcp-external$/, policy: "admin", note: "External 每会话 MCP 配置=基础设施级写，禁止普通用户注入工具连接" },
  { methods: ["POST"], path: /^\/api\/health\/(scan|signals)/, policy: "admin", note: "体检扫描与 healing 信号处置" },
  // POST /api/connections（create）已随死端点下线，本规则休眠但保留作防御纵深——
  // 若未来误挂 POST /api/connections* 写口，仍强制 admin 档（删规则会跌入 fail-closed 兜底 write = 安全降级）
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

/** 反代转发头：任一在场即证明这条请求不是本机直连（客户端可伪造它们，但伪造只会让自己
 *  掉出声明式通道，掉不进更宽的档位——方向安全）。
 *  判「在场」而非「非空」：空值头（`X-Forwarded-For:` 不带值）也是反代留下的痕迹，
 *  按值判定等于给伪造者留一个「发空头」的绕过口。 */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"] as const;

/** node-server 适配器把原始 IncomingMessage 挂在 env.incoming 上；测试/内存 app 没有。 */
interface NodeServerEnv {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** 声明式身份通道的来源闸：仅本机直连（对端回环且无转发头）放行。
 *  对端地址取不到时（内存 app / 单元测试路径）按放行处理——不注入 env 的装配面没有网络来源概念，
 *  生产路径由 node-server 适配器恒提供 env.incoming。 */
export function allowsDeclaredIdentity(c: Context): boolean {
  for (const header of FORWARDING_HEADERS) {
    if (c.req.header(header) !== undefined) return false;
  }
  const remoteAddress = (c.env as NodeServerEnv | undefined)?.incoming?.socket?.remoteAddress;
  if (remoteAddress === undefined) return true;
  return isLoopbackAddress(remoteAddress);
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

/** 会话校验器：给 cookie 值返回可信身份，无效/过期返回 null（注入自 session 工程——见 auth/session-cookie）。 */
export type SessionVerifier = (cookieValue: string) => Identity | null;

/** 服务令牌校验器：给 Bearer token 返回值信任的服务身份，不匹配返回 null。
 *  外部来源（跳反代／跳主机）的可编程入口——声明式头只对本机直连开，服务集成方拿这个。 */
export type ServiceTokenVerifier = (token: string) => Identity | null;

/** 会话通道：cookie 签名校验（真凭据）。无会话/?非法一律 null，交由后续通道决定。 */
function identityFromSession(c: Context, verifySession?: SessionVerifier): Identity | null {
  if (!verifySession) return null;
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionCookie === undefined || sessionCookie === "") return null;
  return verifySession(sessionCookie);
}

/** Bearer 头里的令牌值（无 Authorization / 非 Bearer 形态返回 undefined）。 */
function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/** 服务令牌通道：给集成方（同机或反代之后）的真凭据。与声明式通道无关——
 *  它不受来源闸限制，因为令牌本身就是秘密，伪造需先猜到它。 */
function identityFromServiceToken(c: Context, verifyServiceToken?: ServiceTokenVerifier): Identity | null {
  if (!verifyServiceToken) return null;
  const token = bearerToken(c);
  if (token === undefined) return null;
  return verifyServiceToken(token);
}

/** 声明式通道：身份头优先、query 直链退路（仅本机直连可用，由调用方把闸）。 */
function identityFromDeclaration(c: Context): Identity | null {
  const headerId = nonEmpty(c.req.header(IDENTITY_HEADERS.userId));
  const headerRole = nonEmpty(c.req.header(IDENTITY_HEADERS.role));
  const anyHeader = headerId !== undefined || headerRole !== undefined;
  const userId = anyHeader ? headerId : nonEmpty(c.req.query(IDENTITY_QUERY.userId));
  if (!userId || !ID_PATTERN.test(userId)) return null;
  const rawRole = anyHeader ? headerRole : nonEmpty(c.req.query(IDENTITY_QUERY.role));
  const role: Role = rawRole !== undefined && isRole(rawRole) ? rawRole : "guest";
  return { userId, role };
}

/** 解析身份：会话 cookie 优先（真实登录，不可伪造）→ 声明式头/query 回退（本机运维脚本/测试）。
 *  会话命中即采信，不再看头（同一请求两通道冲突时以结实的会话为准）。
 *  声明式路径通道整体性：任一身份头在场 ⇒ 整体走头通道、query 不参与（防 URL 参数越权上抬
 *  角色——query 会进日志/Referrer，不得与头混通道）；两通道皆无才走 query 直链退路。
 *  来源闸：声明式通道只对**本机直连**开——外部来源（非回环对端，或带转发头）不采信头/query，
 *  没有有效会话就是 null（401）。这样「服务绑非回环地址」或「反代后面忘了改」都不会把
 *  一个可伪造的 admin 头放进去。 */
export function parseIdentity(c: Context, verifySession?: SessionVerifier, verifyServiceToken?: ServiceTokenVerifier): Identity | null {
  const fromSession = identityFromSession(c, verifySession);
  if (fromSession) return fromSession;
  const fromServiceToken = identityFromServiceToken(c, verifyServiceToken);
  if (fromServiceToken) return fromServiceToken;
  if (!allowsDeclaredIdentity(c)) return null;
  return identityFromDeclaration(c);
}

function deny(c: Context, status: 401 | 403, error: string, code: "unauthorized" | "forbidden"): Response {
  return c.json({ error, code }, status);
}

/** 挂在 router 最外层（requestId 之后）：一处覆盖全部既有与新增路由。
 *  verifySession 由装配层注入（app.ts 用 owner token 构造 HMAC 校验器）；测试/引导脚本
 * 不注入时退化为纯声明式路径（既有行为，基线不变）。 */
export function identityMiddleware(verifySession?: SessionVerifier, verifyServiceToken?: ServiceTokenVerifier) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const policy = resolvePolicy(c.req.method, c.req.path);
    if (policy === "public") {
      await next();
      return;
    }
    const identity = parseIdentity(c, verifySession, verifyServiceToken);
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
