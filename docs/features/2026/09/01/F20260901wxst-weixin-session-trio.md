---
id: F20260901wxst
title: 微信会话三小修：热启动 poller 去重 + 删账号清登录会话 + GET headers 对齐
summary: PR #586/#622 检视建议发现的三项独立跟踪修复——#591 出站通道键控注册（同账号重登替换不追加）+ onSuccess accountId 级去重；#592 deleteAccount 时取消关联活跃登录会话并在删号取消路径上不落盘（防「删了又复活」）；#624 api-client GET/POST headers 拆两套构造（GET 无 Content-Type，对齐参考实现 buildCommonHeaders）。
change_type: fix
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
capability_test: "n/a: 纯 bugfix（协议/会话生命周期），无 LLM 行为变更"
tags: [weixin, im, session, poller, login, headers, protocol, bugfix]
modules:
  - src/usecases/im/message-broadcaster.ts
  - src/frameworks/weixin/login-session-manager.ts
  - src/frameworks/weixin/api-client.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
  - tests/usecases/im/message-broadcaster.test.ts
  - tests/usecases/im/message-broadcaster-feishu.test.ts
  - tests/usecases/im/weixin-message-channel.test.ts
  - tests/frameworks/weixin/login-session-manager.test.ts
  - tests/frameworks/weixin/api-client.test.ts
---

# 微信会话三小修：热启动 poller 去重 + 删账号清登录会话 + GET headers 对齐

> 三个 issue 打包一个 PR（都是 PR 检视建议发现的非阻塞小修，同域改动面小，拆三个 PR 的审视开销大于收益）。基于含 F20260901chun 的最新 main——issue 写的文件位置（weixin-connection-controller.ts 在 src/frameworks/web/）已被重构迁移，以下行号以本 PR 基线为准。

## 背景与问题

### #591 热启动重复注册

`WeixinLoginSessionManager.onSuccess` 每次登录成功都 `hotStartWeixinAccount` 创建新 poller。F20260831wxsp 已按 ilinkUserId 回收同扫码人旧轮询（`stopStalePollersForUser`），但检视发现两处残留缺口：

1. **outbound channel 只增不减**：`messageBroadcaster.registerOutboundChannel` 是数组 push，每次热启动追加一条 `WeixinMessageChannel`。旧 poller 停了但它的出站通道还挂在总线上——一条回复会投给新旧两个通道（旧 token 大概率 -14 报错吞在通道 catch 里，但新 token 未失效窗口内就是**重复发送**）
2. **无 accountId 级精确去重**：同 accountId 并发/重放场景下旧 poller 可能残留

### #592 删账号不清登录会话

`deleteAccount` 只停轮询，不清理该账号关联的进行中登录会话。用户开着登录页扫码、中途去删账号：扫码确认后 `login-flow.confirm()` 落盘 → 账号复活。且既有语义「cancel 后完成仍落盘」（微信侧授权已成，不回滚）与「删了又复活」冲突——**取消原因是用户删号时，落盘就是违背用户意图**。

### #624 GET headers 不对齐

`api-client.get()` 复用 POST 的 `buildHeaders()`：GET 无 body 却带 `Content-Type: application/json`。参考实现（openclaw-weixin@2.4.6）GET 用独立 `buildCommonHeaders()`（无 Content-Type）。功能无害（网关忽略多余 header），但协议忠实度有偏差，网关收紧校验时是隐患。

## 方案设计

### 1. MessageBroadcaster 出站通道键控注册（#591 核心）

`registerOutboundChannel(channel)` → `registerOutboundChannel(key, channel)`：

- 内部结构 `messageChannels/eventChannels` 双数组 → `outboundChannels: Map<key, channel>`
- **同 key 再注册 = 替换**（Map.set 语义，保插入序不改变广播顺序）——同账号重登录时新通道直接顶掉旧通道，一条消息只投一次
- 新增 `unregisterOutboundChannel(key): boolean`——停轮询/删账号时成对清理
- key 约定：飞书 `"feishu"`（单通道），微信 `"weixin-<accountId>"`（与 ChannelStatusRegistry 的 channelId 同构）

**取舍**：键控注册是签名破坏性变更（3 个测试文件调用点同步更新）。备选方案「注册时穿透 channel 引用做 identity 比较」不需改签名，但要求 channel 对象暴露 identity 协议——为去重给通道接口加概念，侵入性更大。Map 天然提供替换+删除语义，是最简实现。

### 2. 停轮询路径同步注销出站通道（#591 装配层）

app.ts 三处停 poller 的地方补 `unregisterOutboundChannel`：

- `stopWeixinPoller`（按 accountId）：删除账号/同 id 替换时
- `stopStalePollersForUser`（按 ilinkUserId）：重登录回收僵尸循环时（对齐 F20260901chun 已加的 registry.remove 模式）

onSuccess 回调新增 accountId 级去重：同 accountId 旧 poller 先 stop+注销再热启动（issue 建议的替换语义）——与 stopStalePollersForUser 两道防线独立生效：前者管「同 id」，后者管「同人不同 id」。

### 3. 登录会话账号删除清理（#592）

login-session-manager 新增：

- `cancelByAccountId(accountId): number` —— 按 accountId 取消非终态会话
- `cancelByIlinkUserId(ilinkUserId): number` —— 按扫码人取消非终态会话（会话 accountId 在 confirmed 前不可知，删除时同人窗口内只能按扫码人匹配；同人尚在等待确认的其它会话落盘后就是同一个人的「新账号」，留着必复活）
- `cancellationReason: "account_deleted"` 会话字段 —— 区分「用户手滑取消」（既有语义：完成仍落盘）与「删号取消」（新语义：完成不落盘）
- run() 完成分支检查：cancelled + cancellationReason=account_deleted → `accountStore.removeAccount(accountId)`（微信侧授权已成但用户已表态不要这个账号——删除落盘结果而非回滚授权）
- `onSessionCancelledByAccountDeletion` 回调钩子（默认仅日志，app.ts 可注入扩展清理）

app.ts `onWeixinAccountDeleted` 回调：停轮询后调 `cancelByAccountId` + （有账号记录时）`cancelByIlinkUserId`。

**既有语义保持**：普通 cancel（非删号原因）完成仍落盘——回归测试锁定「#592 不误伤」。

**注意**：`cancelByIlinkUserId` 匹配的会话若已 success（终态），本方法不动它——但 success 意味着账号已落盘+poller 已拉起，删号路径的停轮询清理已覆盖。非终态会话被置 cancelled+account_deleted 后，后台 flow 若继续完成（微信侧授权已成），走到 then 分支按 cancellationReason 分流——这正是防复活的窗口。

### 4. GET/POST headers 两套构造（#624）

`buildHeaders()` 拆为：

- `buildCommonHeaders()` —— 鉴权+自声明字段（AuthorizationType/X-WECHAT-UIN/iLink-App-Id/iLink-App-ClientVersion/Authorization），无 Content-Type。GET 路径用
- `buildPostHeaders()` —— common + `Content-Type: application/json`。POST 路径用

顺手修正源码注释笔误：`0.1.0 → 65536` 实为 `(0<<16)|(1<<8)|0 = 256`（65536 是 1.0.0 的编码）——测试断言 `256` 时发现。

## 改动范围

| 文件 | 改动 |
|---|---|
| `src/usecases/im/message-broadcaster.ts` | 出站通道数组→Map；registerOutboundChannel(key, channel)；新增 unregisterOutboundChannel |
| `src/frameworks/weixin/login-session-manager.ts` | cancelByAccountId/cancelByIlinkUserId/listByAccountId/listByIlinkUserId；cancellationReason 字段；删号取消完成不落盘 |
| `src/frameworks/weixin/api-client.ts` | buildCommonHeaders/buildPostHeaders 拆分；注释笔误修正 |
| `src/bootstrap/platforms.ts` | registerOutboundChannel 调用带 key（weixin-<accountId> / feishu） |
| `src/app.ts` | stopWeixinPoller/stopStalePollersForUser 补 unregister；onSuccess accountId 去重；onWeixinAccountDeleted 补会话清理 |
| 测试 ×5 | 新增用例 + 调用点适配（详见验证节） |

## 验证

- **全仓 vitest**：205 文件 2569 测试全绿（含新增 12 用例）
- **tsc --noEmit**：零错误
- **新增测试**：
  - message-broadcaster：同 key 替换（旧通道不再收/新通道收一次）、替换保插入序、unregister 后不投递+未注册返回 false、不同 key 互不影响（4 例）
  - login-session-manager：cancelByAccountId 仅非终态、cancelByIlinkUserId 标记 account_deleted、删号取消完成不落盘不复活+onSuccess 不触发、普通取消完成仍落盘（既有语义回归锁定）（4 例）
  - api-client：GET 无 Content-Type 且公共头完整、POST 仍带 Content-Type（回归锁定）（2 例）
  - message-broadcaster-feishu：bindFeishu 辅助函数适配 Map（内部实现细节适配，行为断言不变）
- **pre-existing 声明**：无——全绿基线
- **CI**：推送后 `gh run watch` 验证

## 最简实现检查

已过最简检查：键控 Map 是「同 key 替换+成对清理」的最直接表达；备选（channel identity 协议）侵入性更大。会话清理复用已有取消状态机（cancelled 终态），仅加 cancellationReason 分流，未引入新生命周期状态。headers 拆分纯重构，无行为变更（除 GET 不再带 Content-Type）。

## 对旧特性的影响

- F20260829wxch（微信通道核心）的 registerOutboundChannel 调用点已同步更新（platforms.ts 两处 + 测试三处）
- F20260831wxsp 的 stopStalePollersForUser 增强为同时注销出站通道（原只停 poller + registry.remove）
- F20260831dgim 铁律遵守：本文档为新建，未改任何已合入历史文档

## Discovered Issues（顺手发现，未在本 PR 处理）

- `login-flow.ts` confirm() 落盘的 accountId 用 `weixin-${Date.now().toString(36)}`——同毫秒并发两次扫码会撞 id（概率极低，未处理）
- `login-session-manager.ts` cancel() 返回 false 的语义混叠（会话不存在 vs 已终态），前端无法区分——展示层问题，未动
