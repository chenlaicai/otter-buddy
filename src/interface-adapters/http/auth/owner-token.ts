import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Logger } from "@usecases/ports/logger";

/**
 * 单用户自部署的「真实凭据」值源（issue #1868 阶段 2：统一接入与登录）。
 * 替换 F20261019autz 的声明式身份头值源——web 前端不再自报 `web-ui/admin`，而是
 * 经登录端点校验 owner token 后派发会话 cookie；身份中间件从会话派生身份。
 *
 * token 来源优先级：
 *   1. env `OTTER_OWNER_TOKEN`（部署注入，支持 alpha/e2e/生产三态显式指定）；
 *   2. `data/owner-token` 文件（首启自动生成，0600）——token 缺失时生成并落盘，
 *      二次启动自动复用（会话跨重启可续）。
 *
 * 安全边界（诚实声明）：owner token 是本机单用户的登录凭据，不是面向公网的多人权限系统；
 * 它把「谁能在浏览器里拿到 admin 会话」从「任何人伪造头」收口到「持有该 token 的人」。
 */
export const OWNER_TOKEN_ENV = "OTTER_OWNER_TOKEN";
export const OWNER_TOKEN_FILENAME = "owner-token";

/** 生成随机 owner token（base64url，32 bytes → 43 字符，无 base64 歧义字符） */
export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 常数时间比对，防时序侧信道（token 表单字符串比对） */
export function verifyOwnerToken(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ResolveOwnerTokenOptions {
  env?: NodeJS.ProcessEnv;
  dataDir: string;
  logger?: Pick<Logger, "info">;
}

/**
 * 解析 owner token：env 优先，其次 `data/owner-token` 文件，均无则生成并落盘（0600）。
 * 返回最终生效的 token；dataDir 为沙箱父目录（token 文件落在其下）。
 */
export function resolveOwnerToken(options: ResolveOwnerTokenOptions): string {
  const envToken = options.env?.[OWNER_TOKEN_ENV]?.trim();
  if (envToken) return envToken;

  const filePath = path.join(options.dataDir, OWNER_TOKEN_FILENAME);
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 文件不存在或不可读 → 走生成
  }

  const token = generateOwnerToken();
  // 不可读的既有文件这里会抛——老板 token 损坏宁可 fail 也不静默换 token（换 token 会静默踢掉旧会话），
  // 但「整文件不存在」是首启正常路径，必须放行。上面 try/catch 已把 not-found 吞掉；
  // 这里 mkdir/write 失败则向上抛，由启动链 fail-fast。
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  options.logger?.info("Owner token generated", { filePath });
  return token;
}