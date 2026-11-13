import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 会话 cookie 签名/校验（issue #1868 阶段 2）。
 * 无状态 HMAC-SHA256 签名 cookie：`userId.role.issuedAtMs.maxAgeMs.sig`，
 * secret = owner token——轮换 owner token 即整体撤销既有会话（单用户部署可接受的撤销语义，
 * 无需服务端会话表；登录失败/登出由客户端清 cookie + 服务端签名过期双保险）。
 *
 * userId/role 均为服务端签名时注入的受控值（不含 `.` 分隔符），校验侧只做白名单 role。
 */

export const SESSION_COOKIE_NAME = "otter_session";
/** 会话有效期：7 天（单用户本机部署，偏宽松；token 轮换可随时撤销） */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionRole = "admin" | "user" | "guest";

export interface SessionIdentity {
  userId: string;
  role: SessionRole;
}

export interface SessionSigner {
  sign(identity: SessionIdentity, issuedAtMs: number, maxAgeMs?: number): string;
  verify(value: string, nowMs: number): SessionIdentity | null;
}

const ROLE_WHITELIST: readonly SessionRole[] = ["admin", "user", "guest"];

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createSessionSigner(secret: string): SessionSigner {
  return {
    sign(identity, issuedAtMs, maxAgeMs = SESSION_MAX_AGE_MS) {
      const payload = `${identity.userId}.${identity.role}.${issuedAtMs}.${maxAgeMs}`;
      return `${payload}.${hmac(secret, payload)}`;
    },
    verify(value, nowMs) {
      const parts = value.split(".");
      if (parts.length !== 5) return null;
      const [userId, role, issuedAtRaw, maxAgeRaw, sig] = parts;
      if (!userId || !role || !sig) return null;
      const issuedAt = Number(issuedAtRaw);
      const maxAge = Number(maxAgeRaw);
      if (!Number.isFinite(issuedAt) || !Number.isFinite(maxAge) || maxAge <= 0) return null;
      if (nowMs < issuedAt || nowMs > issuedAt + maxAge) return null;
      if (!(ROLE_WHITELIST as readonly string[]).includes(role)) return null;
      const payload = `${userId}.${role}.${issuedAt}.${maxAge}`;
      if (!safeEqual(hmac(secret, payload), sig)) return null;
      return { userId, role: role as SessionRole };
    },
  };
}