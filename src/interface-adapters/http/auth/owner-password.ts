import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Logger } from "@usecases/ports/logger";

/**
 * 单用户自部署的「真实凭据」值源（统一接入与登录）。
 * 替换 的声明式身份头值源——web 前端不再自报 `web-ui/admin`，而是
 * 经登录端点校验登录口令后派发会话 cookie；身份中间件从会话派生身份。
 *
 * 登录口令（owner password）来源优先级：
 *   1. env `OTTER_OWNER_PASSWORD`（部署注入，支持 alpha/e2e/生产三态显式指定）；
 *   2. config.yaml `auth.ownerPassword`（显式自定义的、可读可记的固定登录密码）；
 *   3. `data/owner-password` 文件（首启自动生成，0600）——口令缺失时生成并落盘，
 *      二次启动自动复用（会话跨重启可续）。
 *
 * 安全边界（诚实声明）：登录口令是本机单用户的登录凭据，不是面向公网的多人权限系统；
 * 它把「谁能在浏览器里拿到 admin 会话」从「任何人伪造头」收口到「持有该口令的人」。
 */
export const OWNER_PASSWORD_ENV = "OTTER_OWNER_PASSWORD";
export const OWNER_PASSWORD_FILENAME = "owner-password";

/** 生成随机登录口令（base64url，32 bytes → 43 字符，无 base64 歧义字符） */
export function generateOwnerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** 常数时间比对，防时序侧信道（登录口令表单字符串比对） */
export function verifyOwnerPassword(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ResolveOwnerPasswordOptions {
  env?: NodeJS.ProcessEnv;
  /** config.yaml `auth.ownerPassword`（显式自定义的登录密码；缺省 undefined = 未配置）。 */
  configuredPassword?: string;
  dataDir: string;
  logger?: Pick<Logger, "info" | "warn">;
}

/**
 * 解析登录口令：env 优先，其次 config `auth.ownerPassword`，再次 `data/owner-password` 文件，
 * 均无则生成并落盘（0600）。返回最终生效的口令；dataDir 为沙箱父目录（口令文件落在其下）。
 */
export function resolveOwnerPassword(options: ResolveOwnerPasswordOptions): string {
  const envPassword = options.env?.[OWNER_PASSWORD_ENV]?.trim();
  if (envPassword) return envPassword;

  const configuredPassword = options.configuredPassword?.trim();
  if (configuredPassword) {
    warnIfOverrideFilePassword(options, configuredPassword);
    return configuredPassword;
  }

  const filePath = path.join(options.dataDir, OWNER_PASSWORD_FILENAME);
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
    // 文件存在但内容空白 → 损坏形态：宁 fail 不静默换口令（换口令会静默踢掉旧会话）。
    throw new Error(`登录口令文件存在但内容空白（损坏，宁 fail 不静默换口令）: ${filePath}`);
  } catch (err) {
    // 仅「文件不存在」是首启正常路径，放行走生成；其余（不可读/空白/其他 IO 错误）一律向上抛，
    // 由启动链 fail-fast——与设计取舍「文件损坏宁 fail 不静默换口令」对齐。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const password = generateOwnerPassword();
  // mkdir/write 失败向上抛，由启动链 fail-fast。
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${password}\n`, { mode: 0o600 });
  options.logger?.info("登录口令已生成", { filePath });
  return password;
}

/** delta 检视 config 口令生效时，既有的 data/owner-password 文件若存在且值不同，记 warn——
 *  避免运维拿旧文件口令登录困惑（真正生效的是 config 口令，旧文件值将被忽略）。 */
function warnIfOverrideFilePassword(options: ResolveOwnerPasswordOptions, configuredPassword: string): void {
  const filePath = path.join(options.dataDir, OWNER_PASSWORD_FILENAME);
  try {
    const filePassword = readFileSync(filePath, "utf8").trim();
    if (filePassword && filePassword !== configuredPassword) {
      options.logger?.warn("config auth.ownerPassword 已覆盖 data/owner-password 文件口令（旧文件值将被忽略）", { filePath });
    }
  } catch {
    // 文件不存在/不可读：首启或非文件源场景，无需提示。
  }
}