---
id: F20261120hubex
title: "中枢网页对外：会话 cookie 按请求形态标 Secure，反代配置补齐上传与 SSE 两处静默坑"
summary: "中枢网页入口原本只在本机/回环形态下跑过，代码里会话 cookie 写死 `secure: false`（注释写着「上云时应按部署形态翻转」）。要把 `otter.<域名>` 开到公网，这一条必须先翻：改成按请求形态判定（`X-Forwarded-Proto` 首段为 https 或请求自身协议为 https 才标 Secure，缺失/其他值一律按明文，宁可少标不误标）。同时把 `nginx-otter.conf` 里两个「不报错但功能坏」的坑补上：`client_max_body_size` 默认 1m 会让附件上传在反代层被 413 掉（中枢日志零痕迹），牌局 SSE 走默认 `proxy_buffering on` 会被攒批（表现是慢，不是错）。"
change_type: feature-update
capability_test: "tests/interface-adapters/http/auth-controller.test.ts（新增 2 例：反代 https → 带 Secure / 明文 → 不带；多值转发头取首段、https 以外一律明文）"
intent:
  problem: "中枢网页入口此前没有公网形态：会话 cookie 写死 `secure: false`，注释自陈「本机 http 部署不强制，上云时应按部署形态翻转」。一旦按计划把 `otter.<域名>` 开出去，浏览器→反代这一段是 TLS 而 cookie 不标 Secure，等于给明文降级留口子。同时反代配置只写了「清空声明式身份头」和 WS 透传两件事，缺两处不会报错但会坏功能的配置：上传被 1m 默认上限 413（中枢侧看不到请求，日志零痕迹），牌局 SSE 事件流被默认缓冲攒批（用户看到的是「很慢」）。"
  solution: "① auth-controller 增加 `isSecureRequest`：先看 `X-Forwarded-Proto` 首段，缺失才看请求自身 URL 协议，只认 `https` 字面值——把「本机/上云」的人肉切换改成按请求形态判定。② nginx-otter.conf 补 `client_max_body_size 120m`（对齐中枢 120MB 预检 / 25MB 单文件）、牌局 SSE 专属 location 关 `proxy_buffering`/`proxy_cache` 并延长读超时、TLS 段加 HSTS。③ README 把「公开入口前必须做对的四件事」写成分条，并把登录口令的取法写进验证节。"
  expected_effect: "公网 HTTPS 形态下会话 cookie 带 Secure；附件上传不再被反代层 413；牌局事件流逐帧到达。三者都是「配错不报错」的类型，写成文档条目 + 单测后，后续改 nginx 配置漏一条会被看文档的人当场发现。"
  verify_by:
    type: static_only
created_in_conversation: 0401284f-dff7-4927-af60-3516a984529d
tags: [deploy, nginx, tls, cookie, sse, public-entry]
modules:
  - web
causal_links:
  - {type: "supplements", id: "F20261120svctk", note: "同日另一笔：服务令牌解决的是「不进浏览器」的集成方身份，本笔解决的是「人在浏览器里」的会话形态"}
  - {type: "supplements", id: "F20261120ctopd", note: "拓扑文档写清了中枢网页入口需另装站点；本笔是把站点配置真正补齐到可公开"}
---

# 中枢网页对外（F20261120hubex）

## 背景

搭档拍板：**中枢网页肯定对外**。这是海獭系统自身的事，与 CoLink 无关（CoLink 是外部平台，`app.<域名>` 那条入口只服务平台回调）。

而中枢网页此前只在「本机/回环」形态下跑过。要开公网，除了装站点与证书，还有三处**不报错就坏**的地方要先补。

## 三处坑

| # | 坑 | 不修的表现 |
| --- | --- | --- |
| 1 | 会话 cookie 写死 `secure: false`，注释自陈「上云时应按部署形态翻转」 | 浏览器→反代是 TLS，cookie 却不标 Secure → 明文降级面 |
| 2 | `nginx` 默认 `client_max_body_size 1m`，而中枢允许单请求 120MB（单文件 25MB） | 附件/图片上传被反代层 413；中枢日志**零痕迹**（请求没到中枢），排查会往中枢找 |
| 3 | 牌局 `/api/mahjong/rooms/<id>/events` 是 `text/event-stream`，默认 `proxy_buffering on` | 事件被攒批下发；用户看到「页面很慢」，不是报错 |

## 改了什么

### 1. cookie 按请求形态标 Secure（`auth-controller.ts`）

```ts
export function isSecureRequest(c: Pick<Context, "req">): boolean {
  const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== "") return forwarded === "https";
  return c.req.url.startsWith("https://");
}
```

判据顺序与理由：

- **先看反代头**：经 nginx 终止 TLS 时，请求自身是明文（`http://127.0.0.1:3000`），只有 `X-Forwarded-Proto` 知道真相；
- **多值取首段**：`https, http` 这种链式转发取最外层（浏览器→第一跳）的协议；
- **只认 `https` 字面值**：缺失、空、`http`、`wss` 之类一律按明文——**宁可少标 Secure，也不误标**。误标的代价是「cookie 在某些代理形态下彻底发不出去」，比少标更难查。

### 2. 反代配置三补（`deploy/ecs/nginx-otter.conf`）

- TLS server 段 `client_max_body_size 120m`（与中枢 `Content-Length` 预检同量级）；
- 牌局 SSE 专属 location：`proxy_buffering off` + `proxy_cache off` + 读超时 3600s（与 connector WS 同款长连接处理），并同样清空声明式身份头；
- TLS 段 `add_header Strict-Transport-Security "max-age=31536000" always`。

### 3. 文档（`deploy/ecs/README.md`）

「已知边界 → 对外入口分工」改成两个入口各管一段；新增「公开入口前必须做对的四件事」（清声明式头 / 抬上传上限 / SSE 关缓冲 / 转发协议头留着）；验证节补登录口令的三级取法与三项登录后确认。

## 为什么不顺手收紧「麻将面 public」

试过把 `/api/mahjong` 从 `public` 收紧到 `write`，**验证后回退了**：牌局页是独立静态页，支持「把房间链接发给朋友一起打」，而访客没有登录口令（单用户部署只有 owner 一条口令）。收紧会打断真实玩法，不是修漏洞。

代价是公网上任何拿到房间链接的人都能建房/加入——但这本就是「分享链接即邀请」的语义。**待讨论的替代方案**：对建房加频次限制（匿名建房是内存放大面），而不是直接上身份闸。

## 测试

`tests/interface-adapters/http/auth-controller.test.ts` 新增 2 例：

| 例 | 断言 |
| --- | --- |
| 反代 https / 明文 | `X-Forwarded-Proto: https` → `Set-Cookie` 含 `Secure`；无该头 → 不含 |
| 多值 / 其它值 | `https, http` → 含 `Secure`；`http` → 不含 |

判据落在**发出的 `Set-Cookie` 头**上（不是内部函数返回值），因为线上行为由这个头决定。

## 已知边界

- 本笔只改「配置与代码是否配得上公网」，**站点与证书尚未在线上装**——那一步是独立的生产动作，需搭档点头后执行。
- 登录口令若仍取首启自动生成值，公网开站后需先读到它（`/var/lib/otter-buddy/data/owner-password`），否则等于把自己锁在门外。
