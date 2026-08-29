---
id: F20260829wxui
title: 微信连接管理 UI：web 扫码登录 + 多账号管理
summary: 把微信扫码登录从 CLI 搬到 web（/weixin 页）：登录会话状态机 + QR PNG + 热启动轮询 + 多账号管理，零配置可用（首次登录后自动补写 config.yaml）
status: draft
change_type: feature
created: 2026-08-29
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
issue: "#566"
parents:
  - F20260829wxch
capability_test: "n/a: UI 交互流程，后端逻辑由 tests/frameworks/weixin/login-session-manager.test.ts 覆盖，视觉验收依赖真机扫码（PR 描述已声明）"
---

# 微信连接管理 UI：web 扫码登录 + 多账号管理

## 背景

PR①（F20260829wxch）交付了微信通道核心与 CLI 扫码登录（`npm run weixin:login`）。搭档期望的形态是系统 UI 上直接扫码——本 PR 把扫码登录搬到 web（issue #566）。

## 方案设计

### 架构

复用 PR① 的 `WeixinLoginFlow`（frameworks 层），差异仅在 onQrCode 回调：CLI 渲终端 ASCII，web 渲 PNG dataURL 推给前端。

```
web/weixin 页面 ──POST /api/weixin/login──▶ WeixinLoginSessionManager.start()
        │                                        │ 后台 WeixinLoginFlow.run()
        │◀──GET /api/weixin/login/:id（2s 轮询）──┤ 状态机 pending→waiting_scan→scaned→success
        │                                        │ success: ensureWeixinConfig + hotStart
        └──DELETE /api/weixin/accounts/:id──▶ 停轮询 + removeAccount
```

### 分层落点

| 层 | 文件 | 职责 |
|---|---|---|
| frameworks | `login-session-manager.ts`（新） | 登录会话状态机 + QR PNG 渲染（qrcode 包）+ TTL 清理 |
| frameworks | `account-store.ts` | **顺手修复**：saveAccount/removeAccount 首次落盘（accounts.json 不存在）NPE |
| frameworks | `polling-channel.ts` | 新增 `accountId` getter（删除账号定位停轮询用） |
| bootstrap | `platforms.ts` | 抽 `startWeixinAccount`（单账号启动，初始/热启动共用）+ `hotStartWeixinAccount` + `ensureWeixinConfig`（首次登录补写 config.yaml weixin 段，幂等） |
| bootstrap | `controllers.ts` | 注入登录会话管理 + 账号 store + 删除回调 |
| interface-adapters | `weixin-connection-controller.ts`（新） | 5 端点；依赖 `WeixinLoginSessionPort`/`WeixinAccountStorePort` 接口（避免 interface-adapters→frameworks 分层违规） |
| web | `pages/weixin/index.tsx`（新） | 扫码卡片（PNG 展示 + 状态轮询 + 取消/重试）+ 账号列表（删除） |
| web | `api/client.ts` | 5 个 API 封装 |
| contract | `api-contract/web/pages.ts` | MPA_PAGES 加 weixin 入口（vite/server/TopBar/测试 4 处自动同步） |

### 关键决策

1. **零配置可用**：config.yaml 无 weixin 段也能从 web 发起扫码（默认网关 + 默认 stateDir）；登录成功后 `ensureWeixinConfig` 幂等补写，重启后通道常驻。partnerUserId 缺省取扫码人 ilinkUserId（命令门禁锚定）。
2. **登录成功热启动**：`onSuccess` 回调里 `hotStartWeixinAccount` 拉起轮询（不重启进程），账号删除时按 accountId 停对应 poller。
3. **cancel 后竞态语义**：cancel 时 confirmed 已在路上 → 账号保留（微信侧授权已成，回滚只造成 UI 与存储不一致）、状态停 cancelled、不触发热启动。
4. **controller 依赖端口接口**：WeixinLoginSessionPort/WeixinAccountStorePort 定义在 controller 文件内，实现在 frameworks——依赖倒置，过 no-restricted-imports 架构守卫。
5. **token 脱敏**：账号列表端点只回 hasToken 布尔，bot_token 不出网。

## 验证

- `npx vitest run`：全仓 2070 passed（新增 6：login-session-manager 状态机 6 用例——pending 即返/waiting_scan+PNG/success+落盘+热启动回调/expired 终态/cancel 竞态/终态不可取消）
- `npx tsc --noEmit` + eslint 干净；web `npm run build` 通过
- 测试基建发现并修复两处真 bug：①account-store 首次落盘 NPE（PR① 遗留，CLI 首扫也会炸）；②cancel 后误置 success 状态
- 最简实现检查：已过——复用 login-flow/api-client/account-store/polling-channel 与 MPA_PAGES 单一真相源，新增代码集中在会话管理（197 行）+ controller（103 行）+ 页面（200 行）；qrcode 包是唯一新依赖（PNG 渲染，CLI 的 qrcode-terminal 不支持 web）
- 真机验收（待合入后）：web 点「连接微信」→ 手机扫码 → 账号出现且能收发消息

## Discovered Issues

- account-store saveAccount NPE：本 PR 修复（相关 + 数量 1，顺手修）
- cancel 竞态置 success：本 PR 修复
