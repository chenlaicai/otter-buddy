---
id: F20261113uaccs
title: 统一接入与登录（本机即接入端）
doc_type: feature
summary: |
  落实 #1868 阶段 2：把 Web 客户端的身份来源从「可伪造的声明式头」换成「登录拿到的
  HMAC 签名会话 cookie」，本机 owner token 即唯一真实凭据；执行机投影端点让 Web 显示当前执行机。
  声明式头/query 降级为本机运维脚本回退路径，既有 curl/测试不回归。
change_type: feature
tags: [auth, session, login, execution-machine, web]
modules:
  - src/interface-adapters/http/auth
  - src/interface-adapters/http/controllers/auth-controller.ts
  - src/interface-adapters/http/identity-middleware.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/server.ts
  - src/app.ts
  - web/src/api
  - web/src/hooks/use-session.ts
  - web/src/components/LoginScreen.tsx
  - web/src/components/AppLayout.tsx
  - web/src/components/TopBar.tsx
  - web/e2e/global-setup.ts
capability_test: "n/a: 纯接入与登录装配重构，LLM 决策路径不参与；会话/端点契约均由单测与 e2e 覆盖"
created_in_conversation: 6af46649-f93f-4c5b-a6d2-245a4ed33e9f
created_at: 2026-11-12
intent:
  problem: "Web 客户端凭硬编码 X-Otter-User-Id/Role 声明身份，任何页面都能自报 admin；执行机抽象（阶段 1）无 Web 可见投影，本机角色不可感知"
  expected_effect: "Web 必须登录才能进入业务布局；凭 session cookie 派生 owner/admin 身份；声明式身份仅作本机脚本回退路径；TopBar 显示当前执行机"
  verify_by:
    type: behavior_check
---

# F20261113uaccs：统一接入与登录（本机即接入端）

## 背景

阶段 1（F20261113exmch）建立了执行机抽象，但 Web 客户端的身份仍是 #1322 时代的硬编码
`X-Otter-User-Id: web-ui` / `X-Otter-User-Role: admin` 声明式头。这套头完全可伪造——任何
能打开页面的浏览器（或 curl）都天然是 admin，与「个人云端中枢」的安全叙事不符。

阶段 2 把接入统一为一个真实登录环节：单用户自部署场景下，本机的 owner token 就是唯一真实
凭据；登录成功由服务端派发 HMAC 签名会话 cookie，之后所有 Web 请求凭 cookie 派生身份。
`Web 客户端不再自报身份`——这是本阶段的语义核心。

## 目标

- T1：owner token 解析三层（env → data/owner-token 文件 → 生成落盘 0600），提供轮换/撤销底座。
- T2：无状态 HMAC 会话签名器（secret=owner token，7 天有效），login/logout/session 三端点。
- T3：身份中间件会话优先（cookie 命中不再看头/query），声明式头/query 降级为本机脚本回退路径。
- T4：Web 会话门（LoginScreen + useSession + AppLayout 互锁），登录态进业务布局。
- T5：执行机投影端点 `GET /api/execution-machines`，TopBar 显示当前执行机。

## 非目标

不实现多用户、OAuth/OIDC、速率限制/防爆破、云同步登录态、设备管理 UI；token 轮换即「整体
撤销全部会话」（无状态签名器天然如此）。session cookie 仅在浏览器内存中（无
`Max-Age`/`Expires`），关浏览器即退。

## 方案设计

### 模块切分

- `src/interface-adapters/http/auth/owner-token.ts`：`generateOwnerToken`(base64url 32B)、
  `verifyOwnerToken`(timingSafeEqual)、`resolveOwnerToken`(env 优先 → 文件 → 生成 0600)。
- `src/interface-adapters/http/auth/session-cookie.ts`：`SESSION_COOKIE_NAME='otter_session'`、
  7 天有效期、`createSessionSigner(secret)` HMAC-SHA256 无状态签名
  `userId.role.issuedAt.maxAge.sig`。
- `src/interface-adapters/http/controllers/auth-controller.ts`：login(public) / logout(public) /
  session(authenticated)。
- `src/interface-adapters/http/identity-middleware.ts`：会话优先解析 + `SessionVerifier` 注入 +
  策略表新增 `/api/auth/(login|logout)` public。
- `src/interface-adapters/http/router.ts`：`RouterPlumbingOptions` 可选装配；`createRouter` 第三参
  注入 auth + executionMachines；`registerPlumbingRoutes` 拆出守住函数行数预算。
- `src/bootstrap/server.ts` / `src/app.ts`：`buildHttpApp` 第 5 参透传，组合根装配 plumbing。
- 执行机域：`ExecutionMachine.name?`、`Registry.list()`/`currentMachineId()`、`LocalExecutionMachine.name='本机'`。
- Web 切片：`api/auth.ts`、`api/client.ts`(credentials same-origin + 401 广播)、
  `hooks/use-session.ts`、`components/LoginScreen.tsx`、`AppLayout.tsx`(会话门)、`TopBar.tsx`(执行机 badge)、
  `conversation/index.tsx`(SSE 订阅不再设声明式头)。
- e2e：`web/e2e/global-setup.ts` 用 `E2E_OWNER_TOKEN` POST 登录写 storageState；启动脚本注入同 token。

### 关键接口与核心数据结构

```ts
createSessionSigner(secret: string): {
  sign(identity: { userId: string; role: Role }, now: number): string;
  verify(cookieValue: string, now: number): SessionIdentity | null;
}
```

cookie 值形态：`${userId}.${role}.${issuedAt}.${maxAge}.${sig}`（HMAC-SHA256，`===` 常数时间比对）。
`SessionIdentity = { userId: string; role: "admin" | "user" | "guest" }`。

`RouterPlumbingOptions`（模块级可选装配；测试不传则退化为 F20261019autz 基线）：

```ts
interface RouterPlumbingOptions {
  auth?: { verifySession: SessionVerifier; controller: AuthController };
  executionMachines?: { list: () => Array<{ id: string; name: string }>; currentId: () => string };
}
```

### 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| 会话凭据 | 无状态 HMAC 签名 cookie，secret=owner token | 服务端 session 表 / 数据库落 session | 单用户自部署无状态免存储；轮换 token 即整体撤销，无需 GC；失败模式简单可测 |
| Web 身份值源 | 登录 cookie 会话，不再发声明式头 | 保留头 + cookie 双通道 | 保留头则 Web 永远无法「登出」——过期 cookie 仍会掉进 admin 回退路径，登录门形同虚设 |
| 声明式头/query | 降级为本机脚本回退路径（103 处 curl/测试继续可用） | 直接删除声明式路径 | 一次性删光会让既有运维脚本与集成测试大面积回归，且后台探活在浏览器场景外仍需脚本身份 |
| 会话优先 | cookie 命中则不再看头/query（明文头造假无效） | 头优先 / 合并 | 头可伪造，必须在可验证凭据面前让位；合并语义会引入歧义 |
| owner token | env `OTTER_OWNER_TOKEN` 优先，缺省生成 `data/owner-token`(0600) | 仅 env / 仅文件 | 三态（生产部署/alpha/e2e）显式注入优先；本机零配置首启可用；文件损坏宁 fail 不静默换 token |
| 会话有效期 | 7 天；`now = issuedAt+maxAge` 边界仍有效，`+1ms` 起拒绝 | 更长/更短 | 个人中枢本机访问为主，7 天与轮换撤销配合足够 |
| SSE 身份 | 同源 XHR 自动携带会话 cookie | 继续给 SSE XHR 设声明式头 | 与 Web 整体「不自报身份」语义一致；cookie 由浏览器自动附带 |

### 机制识别检查点

- 新增配置字段：是（`OTTER_OWNER_TOKEN` env，可缺省）。
- 新增状态生命周期：是（会话 cookie 持有期 7 天，无状态无存储）。
- 新增定时任务/后台进程：否。
- 新增信号类型/消息格式：是（session cookie 值格式 `userId.role.issuedAt.maxAge.sig`）。
- 新增持久化存储：是（`data/owner-token` 首启生成，0600）。
- 新增会被记住的决策分支：是（会话优先于声明式身份的解析顺序）。
- 新增跨模块调用路径：是（app → resolveOwnerToken → createSessionSigner → AuthController → router 中间件/端点）。

结论：命中配置、消息格式、持久化、决策分支与跨模块路径，属修法决策树④新增机制。既有「声明式身份」机制内无法同时满足
「Web 不能自报可伪造 admin」与「本机脚本仍可无 cookie 调用」——前者要求删 Web 头，后者要求留路径，只有把真实登录设为
主通道、声明式降级为回退通道才能两者兼得。

### 机制预算四问

1. **谁需要它**：#1868 已拍板端云一体的安全叙事；本机大獭/小獭与 Web 同源访问需要单一真实凭据入口，后续阶段的多终端接入复用同一会话签名器。
2. **失败后果**：登录失败只会挡住 Web 业务布局（不会破坏服务启动）；若会话校验误拒绝，用户被登出可见；若回退路径误放行，头伪造即 admin——故回退路径必须与既有基线行为一致且用测试钉死。
3. **后续机制**：token 轮换唤醒需求、会话撤销审计；7 天无状态语义由签名器测试固化。签名器升级/删除需先迁移所有 Web 调用点到新凭据并跑 e2e。
4. **退役条件**：若未来引入多用户中央 IdP（OIDC 等），本 owner-token 登录可保留为 bootstrap/本机 fallback；仅当所有接入方迁移且无状态 cookie 被 IdP 会话替代、声明式回退路径确认无消费者后可整体删除。

### 机制提案准入三问

1. **决策者变了么**：没有。登录成功与否判断由服务端机械校验；Web 布局互锁由 useSession 状态机守卫，不涉及 LLM。
2. **靠自觉还是靠守卫**：会话签名/过期/篡改/role 白名单/会话优先于伪造头/登录成败/登出幂等/执行机契约均有单测；
   e2e global-setup 真实 POST 登录写 storageState、43 条 e2e 以登录态跑通。非靠自觉。
3. **深潜成本降了吗**：是。auth 目录集中三文件，身份解析单一中间件，登录链路在 app.ts 组合根可见。
4. **P0 负面清单**：未命中；不自动巡检、不替人审批、不自动跳过或重放。

### 重对抗门

阶段 2 简单接入重构，风险集中在其一副作用（移除 Web 声明式头后 jsdom 单测对 SSE XHR 行为的隐性依赖）。
施工中经实验定位：`index.spa-nav.test.tsx` 的右栏对账用例隐式依赖「SSE XHR 设了 X-Otter-User-Id 头使 jsdom 请求落失败路径、
不产生数据帧」，移除头后 jsdom XHR 实际收到数据并进入重连补偿链污染计数断言。处置为在该 describe 注入静默 SSE 桩
（该组只测右栏对账、不测订阅链路），使断言对齐「会话身份」语义而非头在场。测试修正后主仓/工树全绿。

## 影响范围

Web 浏览器交互需登录；本机远程 API 调用（curl/脚本/后台探活）仍走声明式身份回退路径，行为与基线一致。
服务端 auth 装配经 `RouterPlumbingOptions` 可选注入，测试不传则无 auth 端点、纯声明式路径——既有
tests/api 与 tests/interface-adapters/http 基线不回归。

## 风险与约束

- 删除 `data/owner-token` 会整体登出所有会话（含 alpha/e2e 首启后的已登录态）；
  生产首次部署若未设 `OTTER_OWNER_TOKEN` 则生成的 token 必须妥善保管于本机。
- cookie 未设 `Secure`（本机 http 场景）；部署到公网需由反向代理终止 TLS 并另评估 Secure 标志。
- 轮换 token 应立即重启服务（会话签名器 secret 为启动时快照）。

## 验收标准

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 登录成败 | login 端点对/错 token | 对 → 200 + otter_session cookie；错/缺 → 401 invalid_token |
| 会话读取 | 带 cookie 请求 session | 200，identity = owner/admin |
| 会话优先 | 有效 cookie + 伪造 admin 头 | 采信 cookie 的 owner |
| 未登录拒绝 | 无 cookie 请求 session / execution-machines | 401（fail-closed） |
| 登出幂等 | logout 有/无 cookie | 均 200；登出后 session 401 |
| 端点契约 | 登录后 GET /api/execution-machines | `{ machines:[{id, name}], currentMachineId }` |
| 过期边界 | 签名器 at issuedAt+maxAge | 有效；+1ms 拒绝 |
| Web 会话门 | 未登录加载业务页 | 渲染登录屏，不挂载业务布局 |
| 执行机 badge | 登录后 TopBar | 显示「执行机：本机」 |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit`（服务端 + web） | PASS；加入 env 装配修复后无类型错误 |
| `npm run build` | PASS；SDK patch 校验 + tsc + tsc-alias + 模型复用 |
| `npm run lint` | PASS：0 problems（含 max-lines-per-function 路由拆解后） |
| 服务端 `npm test` | PASS：474 files / 5982 tests（新增 auth 三件套 + 执行机契约 19 例，既有 21 例 identity 不回归） |
| web `vitest run` | PASS：83 files / 851 tests |
| Playwright e2e | PASS：43 passed / 8 skipped；global-setup 真实登录写 `otter_session` storageState |
| `npm run check` | PASS：build + lint + schema + smoke:boot（全新/存量双库）+ 三个脚本/端口/探活检查，EXIT 0 |
| alpha 真启动（main 入口点，e2e 配置） | PASS：`OTTER_OWNER_TOKEN` env 生效（无 Owner token generated 日志）；登录 → cookie → session → 页面 e2e 全通 |
| GitHub CI | PR 创建后运行（见 PR checks） |

最简实现检查：已通过。复用既有 identity-middleware 策略表与 fail-closed，不新起第二鉴权层；
hmac 用 node:crypto 内建，无新依赖；session cookie 无状态免存储。发现并修复 app.ts 未向
`resolveOwnerToken` 传递 `env`（env 注入实际失效）的装配缺口。

负面向核查：未删除声明式身份任何既有放行路径（103 处 curl/测试脚本仍可无 cookie 调用）；
未改变 identity-middleware 对未知 route 的 fail-closed；Web 布局互锁只在 unauthenticated 态
（authenticated 态渲染路径与基线一致）；SSE 订阅仅移除自报头，同源 cookie 由浏览器自动携带。