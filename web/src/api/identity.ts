/** 统一接入登录（issue #1868 阶段 2）——web 身份接入点替换。
 *
 *  F20261019autz 基线：web 自报硬编码 `X-Otter-User-Id: web-ui` + `X-Otter-User-Role: admin`
 *  （声明式身份值源，公网可伪造）。阶段 2 起 web 的请求身份**随会话 cookie 派生**——
 *  login 后服务端派发 httpOnly 会话 cookie，同源 fetch/XHR/直链（img/audio/a）自动携带，
 *  不再发声明头。本文件保留 identityHeaders/withIdentity 两个导出名以不打破调用面，
 *  identityHeaders 返回空对象（身份由 cookie 承担），withIdentity 恒等返回 path。
 *  服务端「声明式头/query」路径仍保留给本机运维脚本与测试（见 identity-middleware 取舍）。
 */

/** @deprecated 身份改由会话 cookie 承担；此导出仅为不打破既有调用面（返回空头）。 */
export function identityHeaders(): Record<string, string> {
  return {}
}

/** 直链（img/audio/a href）身份：同源请求自动携带会话 cookie，无需再拼 query 身份。 */
export function withIdentity(path: string): string {
  return path
}
