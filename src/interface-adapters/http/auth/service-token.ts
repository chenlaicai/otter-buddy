import type { Identity, ServiceTokenVerifier } from "../identity-middleware";
import { constantTimeStringEquals } from "./owner-password";

/**
 * 服务令牌：给「会跳反代或跨主机」的集成方一个**不可伪造**的编程入口。
 *
 * 为什么需要它：HTTP 面的声明式身份头（`X-Otter-User-*` / `?otterRole=`）是接缝不是凭据，
 * 只能对本机直连开（反代之后对端恒为回环，光看地址判不出来）。而集成方（如部署在同机的
 * 外部通道适配进程）一旦通过公网域名 / 反代访问中枢，就落到「外部来源」这一侧——它需要
 * 一个真凭据，这个令牌就是那个凭据：令牌即秘密，猜不到就过不去，与来源无关。
 *
 * 语义边界：
 * - 只在配置或环境里显式给出时存在（未配置 = 通道不存在，Bearer 被忽略）；
 * - 授予固定服务身份（`service-token` / admin）——单用户部署里它就是「系统自己」；
 * - 比较走常数时间，长度差先短路（防逐字节计时侧信道）；
 * - 太短（<16）视为危险配置，启动期 fail-fast：这是唯一凭据，可猜中等于没有。
 */

/** 令牌最小长度：16 字符起步（32+ 更好，文档建议 `openssl rand -base64 32`）。 */
export const SERVICE_TOKEN_MIN_LENGTH = 16;

export interface ResolveServiceTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** config.yaml `auth.serviceToken`（缺省 undefined = 未配置）。 */
  configured?: string;
}

/** 解析生效的服务令牌：env 优先于配置文件（与登录口令同一优先级口径——env 是部署面，config 是仓内默认）。 */
export function resolveServiceToken({ env, configured }: ResolveServiceTokenOptions = {}): string | undefined {
  const fromEnv = typeof env?.OTTER_SERVICE_TOKEN === "string" ? env.OTTER_SERVICE_TOKEN.trim() : "";
  const fromConfig = typeof configured === "string" ? configured.trim() : "";
  const token = fromEnv !== "" ? fromEnv : fromConfig;
  if (token === "") return undefined;
  if (token.length < SERVICE_TOKEN_MIN_LENGTH) {
    throw new Error(
      `服务令牌太短（${token.length} 个字符）：它是唯一凭据，至少 ${SERVICE_TOKEN_MIN_LENGTH} 个字符` +
        "（建议 openssl rand -base64 32）。来源：env OTTER_SERVICE_TOKEN 或 config.yaml auth.serviceToken",
    );
  }
  return token;
}

/** 构造令牌校验器：命中返回固定服务身份，否则 null。 */
export function createServiceTokenVerifier(token: string): ServiceTokenVerifier {
  return (candidate: string): Identity | null =>
    constantTimeStringEquals(token, candidate) ? { userId: "service-token", role: "admin" } : null;
}
