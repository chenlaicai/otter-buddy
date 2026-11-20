import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../auth/session-cookie";

/**
 * 统一接入登录控制器。
 * 单用户自部署：一个登录口令 ↔ 一个 admin 会话。登录成功后派发 HMAC 签名会话 cookie，
 * 身份中间件后续从 cookie 派生身份（不再信任 web 自报的声明式头）。
 */

export interface AuthControllerDeps {
  verifyOwnerPassword: (password: string) => boolean;
  signSession: (identity: { userId: string; role: "admin" | "user" | "guest" }) => string;
}

export const OWNER_SESSION_USER_ID = "owner";

/** 请求是否走 TLS：反代（经 nginx 终止 TLS）看 `X-Forwarded-Proto`，直连看自身 URL 协议。
 *  只认 `https` 字面值；缺失或多值取第一段，别的一概当明文——宁可少标 Secure 也不误标。 */
export function isSecureRequest(c: Pick<Context, "req">): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== "") return forwarded === "https";
  return c.req.url.startsWith("https://");
}

export class AuthController {
  constructor(private readonly deps: AuthControllerDeps) {}

  /** POST /api/auth/login（public）：校验登录口令，派发会话 cookie。 */
  async login(c: Context): Promise<Response> {
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !this.deps.verifyOwnerPassword(password)) {
      return c.json({ error: "登录口令错误", code: "invalid_password" }, 401);
    }
    const identity = { userId: OWNER_SESSION_USER_ID, role: "admin" as const };
    const cookie = this.deps.signSession(identity);
    setCookie(c, SESSION_COOKIE_NAME, cookie, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
      // 按请求形态翻转，而不是按「本机/上云」人肉切换：经反代到达时浏览器→反代这一段
      // 已经是 TLS，cookie 不标 Secure 就等于允许它随明文请求出走。
      secure: isSecureRequest(c),
    });
    return c.json({ ok: true, identity });
  }

  /** POST /api/auth/logout（public）：清客户端会话 cookie（登出幂等，未登录调用也 200）。
   *  无状态签名器下登出不撤销已签发的 cookie 值——旧值 7 天内仍可凭 HMAC 签名通过校验；
   *  整体撤销靠轮换登录口令（secret 变更即全部既有会话失效）。 */
  async logout(c: Context): Promise<Response> {
    const existing = getCookie(c, SESSION_COOKIE_NAME);
    if (existing !== undefined) deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  }

  /** GET /api/auth/session（authenticated）：当前会话身份（能走到这里 = 中间件已放行）。
   *  兜底 fail-closed：identity 缺失（异常装配路径）返回 401，而非 fabricate admin。 */
  async session(c: Context): Promise<Response> {
    const identity = c.get("identity" as never) as { userId: string; role: string } | undefined;
    if (!identity) return c.json({ error: "Unauthenticated", code: "unauthenticated" }, 401);
    return c.json({ ok: true, identity });
  }
}