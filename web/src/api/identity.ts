/** #1322 对话域鉴权身份声明（F20261016autz）——web 侧唯一接入点（策略表/契约见
 *  src/interface-adapters/http/identity-middleware.ts 与特性文档）。
 *
 *  单用户自部署现状：web UI = 唯一人类（搭档）= admin。值源是**声明**不是凭据——
 *  session/凭据体系落地时只替换这里的值源（身份头随 session 派生），策略表与调用面不动。 */
export const OTTER_USER_ID = 'web-ui'
export const OTTER_USER_ROLE = 'admin'

/** 请求头形态：request() / 直连 fetch / XHR SSE 订阅用 */
export function identityHeaders(): Record<string, string> {
  return { 'X-Otter-User-Id': OTTER_USER_ID, 'X-Otter-User-Role': OTTER_USER_ROLE }
}

/** 直链形态：<img>/<audio>/<a href> 设不了请求头 → 退化为 query 参数（中间件两通道等价） */
export function withIdentity(path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}otterUserId=${encodeURIComponent(OTTER_USER_ID)}&otterRole=${encodeURIComponent(OTTER_USER_ROLE)}`
}
