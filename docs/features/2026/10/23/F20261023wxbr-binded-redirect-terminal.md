---
id: F20261023wxbr
title: 微信扫码 binded_redirect 终态语义补全（#1112）
change_type: fix
status: implemented
created: 2026-10-23
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/weixin/login-flow.ts
  - src/frameworks/weixin/login-session-manager.ts
  - scripts/weixin-login.mjs
  - web/src/api/client.ts
  - web/src/components/weixin/QRCodeLoginCard.tsx
summary: "issue #1112（PR #1110 审视 A3）：WeixinQrStatus 枚举含 binded_redirect 但全仓无 case，落 default 透传继续轮询到 5 分钟超时（与 #571 scaned_but_redirect 同族）。审计参考实现（@tencent-weixin/openclaw-weixin@2.4.6 login-qr.ts:389）确认语义：终态「bot 已绑定本实例」——服务端不签发新凭证、本地凭证继续有效、是成功「已连接过」而非登录失败。按语义实现：login-flow 补 case 返回 alreadyConnected 终态（run() 返回 union），session-manager 增 already_connected 终态（不落盘不热启动），CLI/web 双消费端友好提示。"
tags: [weixin, login, qr, protocol, fix]
capability_test: tests/frameworks/weixin/login-flow.test.ts + tests/frameworks/weixin/login-session-manager.test.ts + web/src/components/weixin/QRCodeLoginCard.test.tsx
from: [F20260922wxlg]
---

# 微信扫码 binded_redirect 终态语义补全（#1112）

issue #1112（P2 tech-debt，PR #1110 对抗审视建议发现 A3，检视獭1110）。处置方向（issue 原文）：先审计参考实现确认 `binded_redirect` 真实语义——是终态（已绑定）、是另一种 redirect（需切网关）、还是可安全当 wait 处理——**不在无依据下臆写 case**；确认语义后按结论实现或删除枚举。

## 1. 语义审计结论（本单核心交付物）

审计对象：`@tencent-weixin/openclaw-weixin@2.4.6`（MIT，npm 包内含完整 TS 源码）`src/auth/login-qr.ts`。审计方式：npm pack 重新下载解包（此前审计产物 /tmp 已失，协议笔记见他线工作区 openclaw-weixin-protocol-notes.md）。

**结论：`binded_redirect` 是终态，语义 =「已连接过此实例，无需重复连接」。**

| 证据锚点 | 内容 |
|---|---|
| login-qr.ts:163-168（WeixinQrWaitResult.alreadyConnected 注释） | "the scanned bot is already bound to this OpenClaw instance, so no new credentials are issued and existing local credentials remain valid. Callers should treat this as a successful outcome (semantically \"already done\") rather than a login failure." |
| login-qr.ts:389-397（case 实现） | 返回 `{ connected: false, alreadyConnected: true, message: "已连接过此 OpenClaw，无需重复连接。" }`，终止轮询，不刷码不重试 |

三个候选语义的裁定：
1. ~~是终态（已绑定）~~ → **命中**
2. ~~是另一种 redirect（需切网关）~~ → 排除：参考实现该 case 不消费 redirect_host/baseurl，无网关切换动作
3. ~~可安全当 wait 处理~~ → 排除：参考实现一轮即终止，当 wait 会空转到超时

**现状 bug 确认**：我方 `handleNonConfirmed`（login-flow.ts）无该 case，落 default「透传继续轮询」→ 与 #571 同族（状态未处理致 5 分钟超时假死）。binded_redirect 场景（重复扫码已绑定 bot）下用户永远等不到反馈。

## 2. 方案设计

按审计结论实现（不删枚举——枚举值是真实协议状态）：

| 层 | 变更 |
|---|---|
| login-flow.ts | `handleNonConfirmed` 补 `case "binded_redirect"` → 返回 `"already-connected"` 终态信号；`run()` 返回类型扩为 union `WeixinLoginResult = { alreadyConnected: true } \| { accountId: string; ilinkUserId?: string }` |
| login-session-manager.ts | `WeixinLoginSessionStatus` 增 `"already_connected"` 终态（不落盘、不触发 onSuccess——本地凭证继续有效，既有账号与 poller 不受影响）；已取消会话收到 binded_redirect 保持 cancelled（无落盘副作用无需善后）；终态集合抽 `TERMINAL_STATUSES` 常量复用 |
| scripts/weixin-login.mjs | alreadyConnected → 「该微信已连接过此实例，无需重复连接」exit 0 |
| web client + QRCodeLoginCard | DTO status union 增 `already_connected`；STATUS_LABEL 文案 + 轮询终态分流（toast info，不触发 onLoginConfirmed——无新账号可建线） |

### 设计取舍

**机制判定**（issue 驱动未经 RA，步骤 3 前置判定）：偏严清单命中「新增枚举值」（session status 加 already_connected）→ 修法决策树走 **① 在既有机制语义内修（缺啥补啥）**：协议枚举值 `binded_redirect`（types.ts:193）与会话终态机制（success/expired/error/cancelled）均早已存在，本修复仅为既有状态机补缺失 case 与既有终态机制的映射，无新守护/新存储/新定时任务/新跨模块调用路径，不涉净新增机制。Modification-Class: narrow-fix。

**alreadyConnected 表达形态**：用返回值 union 而非错误抛出——参考实现明示「treat as successful outcome rather than a login failure」，用 error 表达成功终态语义扭曲（web 侧会误显「连接失败」红条）。union 代价是消费端解构需收窄（两处测试解构已用 expectConfirmed helper 收窄）。

**负面影响自查（负面向验收条目）**：本次变更破坏的旧契约 = `WeixinLoginFlow.run()` 返回类型从单形态扩为 union——**对调用方是 breaking type change**（tsc 会强制所有调用点显式处理新分支，实测抓到 2 处既有测试解构报 TS2339，已修）。生产调用点 2 处（login-session-manager / CLI）已同步改。无运行时行为回退：confirmed/expired/error/verify_code 各分支语义不变。

**cancel() 语义保持**：既有 cancel() 判「success/error/expired 不可取消、已 cancelled 重复 cancel 返回 true（幂等）」——already_connected 按同构加入不可取消侧，cancelled 不进判断，存量契约不变（测试 cancel() 幂等用例回归过）。

## 3. 验证

**验收标准（机械断言）**：

| 场景 | 操作 | 预期结果 | 实测 |
|---|---|---|---|
| binded_redirect 终态 | login-flow.test.ts | run() 返回 {alreadyConnected:true}，不落盘不抛错 | PASS |
| 不空转超时 | 同上 | get_qrcode_status 调用恰 1 次即停 | PASS |
| union 判别 | 同上 | confirmed 与 alreadyConnected 形态可区分 | PASS |
| 会话终态 | login-session-manager.test.ts | already_connected 不落盘不热启动、cancel() 拒绝、已取消不覆写 | PASS |
| web 终态 | QRCodeLoginCard.test.tsx | 文案渲染 + info toast + 不触发 onLoginConfirmed + 停轮询 + 重扫按钮可用 | PASS |
| 全量回归 | npx vitest run（根） | 421 文件 6760 用例绿（6 skip 存量） | PASS |
| web 全量 | cd web && npx vitest run | 77 文件 782 用例绿（基线 778 + 新增 4） | PASS |
| 类型+lint | npm run check | EXIT=0 | PASS |

**最简实现检查**：已过——补 case + 终态映射为达成语义的最小改动；无新依赖、无新生产文件（仅测试新增 1 文件）；error 抛出形态更省（免改 run 签名）但被参考实现语义否决，非更简而是更错。

**Golden Gate**: n/a（verify_by 场景不适用——纯 TS 行为修复非 prompt/skill/协议软代码，golden 无对应场景）。

**测试规模**：新增 10 用例（login-flow 3 + session-manager 3 + QRCodeLoginCard 4）。

**QRCodeLoginCard 测试面边界**：本文件仅覆盖 #1112 行为改动（终态分流），组件全面测试面（二维码渲染/取消/重试/配对码）归 #1079 检视 2 派生的待立案项（净增熔断期暂不立），本单不越界。

## 4. 影响面

- 与 #571（F20260922wxlg）同族收官：scaned_but_redirect（切网关继续）与 binded_redirect（终态已绑定）两个 redirect 语义至此都有明确 case，扫码状态机不再有「未处理状态落 default 空转」的已知缺口
- need_verifycode / verify_code_blocked 等其余枚举值均已有 case，状态机覆盖完整
- 无 api-contract 变更（controller 端口 status 本就 string 透传）
