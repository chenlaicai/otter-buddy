import type { Context } from "hono";

/**
 * #889：安全的 JSON body 解析——非法 JSON 与合法 JSON `null` 统一兜底为 {}。
 *
 * 背景：`await c.req.json().catch(() => ({}))` 只能防住「非 JSON body」，
 * 防不住「合法 JSON null」——json() 解析 "null" 成功返回 null 不走 catch，
 * 后续 body.xxx 解引用崩溃 500 并回显 V8 内部错误文本。
 * 需要区分「无 body 合法」与「null body 非法」的端点应直接使用本 helper
 * 并把 null 视为 {}（消费方对缺字段做校验），或自行判空。
 */
export async function safeJsonBody<T extends object = Record<string, unknown>>(
  c: Context,
): Promise<T> {
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  return body as T;
}
