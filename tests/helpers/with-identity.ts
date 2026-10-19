import type { Hono } from "hono";

/**
 * #1322（F20261016autz）测试身份注入：给被测 app 的 request 补默认身份头（admin 档）。
 *
 * 业务用例不该被身份噪声污染——鉴权矩阵本身用**裸 app**（createRouter/mini-app 直建，
 * 不经此包装），见 tests/interface-adapters/http/identity-middleware.test.ts。
 */
export const TEST_IDENTITY_HEADERS: Record<string, string> = {
  "X-Otter-User-Id": "test-client",
  "X-Otter-User-Role": "admin",
};

/** 本仓主 tsconfig 无 DOM 全局（HeadersInit/RequestInfo 不可见）——内部入参收 unknown 自防御 */
function toRecord(h: unknown): Record<string, string> {
  if (!h) return {};
  if (typeof Headers !== "undefined" && h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

/** 覆写 app.request 注入身份头后委托原实现；返回同一实例（就地包装，调用点零改动）。
 *  调用方自带的身份头优先（可被测试覆写为低档角色）。 */
export function withIdentity(app: Hono, headers: Record<string, string> = TEST_IDENTITY_HEADERS): Hono {
  const original = app.request.bind(app);
  const patched = (path: Parameters<typeof app.request>[0], init?: Parameters<typeof app.request>[1]) =>
    original(path, { ...init, headers: { ...headers, ...toRecord(init?.headers) } });
  (app as { request: typeof app.request }).request = patched as typeof app.request;
  return app;
}
