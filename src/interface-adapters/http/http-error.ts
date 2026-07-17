import type { Context } from "hono";
import type { DomainErrorKind } from "@entities/errors";
import { DomainError } from "@entities/errors";

/** HTTP 错误类：携带状态码，避免字符串匹配不可靠 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const DOMAIN_ERROR_STATUS: Record<DomainErrorKind, number> = {
  not_found: 404,
  conflict: 409,
  validation: 400,
  forbidden: 403,
};

/** 安全获取路径参数 */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new DomainError(`Missing path parameter: ${name}`, "not_found");
  return val;
}

/** 根据错误类型返回 HTTP 状态码并返回 JSON 响应 */
export function handleError(c: Context, err: unknown): Response {
  if (err instanceof DomainError) {
    const status = DOMAIN_ERROR_STATUS[err.kind];
    return c.json({ error: err.message }, status as 400 | 404 | 409 | 500);
  }
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400 | 404 | 500);
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return c.json({ error: msg }, 500);
}
