import type { Context } from "hono";

/** HTTP 错误类：携带状态码，避免字符串匹配不可靠 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** 安全获取路径参数 */
export function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing path parameter: ${name}`);
  return val;
}

/** 根据错误类型返回 HTTP 状态码并返回 JSON 响应 */
export function handleError(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400 | 404 | 500);
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  if (msg.includes("not found") || msg.includes("Missing path parameter")) {
    return c.json({ error: msg }, 404);
  }
  if (msg.includes("already exists") || msg.includes("must be") || msg.includes("Invalid")) {
    return c.json({ error: msg }, 400);
  }
  return c.json({ error: msg }, 500);
}
