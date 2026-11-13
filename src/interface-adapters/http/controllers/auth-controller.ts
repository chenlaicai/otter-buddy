import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../auth/session-cookie";

/**
 * 统一接入登录控制器（issue #1868 阶段 2）。
 * 单用户自部署：一个 owner token ↔ 一个 admin 会话。登录成功后派发 HMAC 签名会话 cookie，
 * 身份中间件后续从 cookie 派生身份（不再信任 web 自报的声明式头）。
 */

export interface AuthControllerDeps {
  verifyOwnerToken: (token: string) => boolean;
  signSession: (identity: { userId: string; role: "admin" | "user" | "guest" }) => string;
}

export const OWNER_SESSION_USER_ID = "owner";

export class AuthController {
  constructor(private readonly deps: AuthControllerDeps) {}

  /** POST /api/auth/login（public）：校验 owner token，派发会话 cookie。 */
  async login(c: Context): Promise<Response> {
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    if (!token || !this.deps.verifyOwnerToken(token)) {
      return c.json({ error: "Invalid owner token", code: "invalid_token" }, 401);
    }
    const identity = { userId: OWNER_SESSION_USER_ID, role: "admin" as const };
    const cookie = this.deps.signSession(identity);
    setCookie(c, SESSION_COOKIE_NAME, cookie, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
      // 本机 http 部署不强制 Secure；上云（阶段 6）时应按部署形态翻转。
      secure: false,
    });
    return c.json({ ok: true, identity });
  }

  /** POST /api/auth/logout（public）：清会话 cookie（登出幂等，未登录调用也 200）。 */
  async logout(c: Context): Promise<Response> {
    const existing = getCookie(c, SESSION_COOKIE_NAME);
    if (existing !== undefined) deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  }

  /** GET /api/auth/session（authenticated）：当前会话身份（能走到这里 = 中间件已放行）。 */
  async session(c: Context): Promise<Response> {
    const identity = c.get("identity" as never) as { userId: string; role: string } | undefined;
    return c.json({ ok: true, identity: identity ?? { userId: OWNER_SESSION_USER_ID, role: "admin" } });
  }
}