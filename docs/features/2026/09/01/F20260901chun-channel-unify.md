---
id: F20260901chun
title: IM 通道统一整合：微信/飞书归一 + 真实健康状态
summary: 将《连接》（IM 大厅）与《微信》两个目录整合为统一「IM」页；通道状态从静态档案显示改为轮询层实时上报的探活状态，消除"token 已死 UI 仍显示已连接"的失真；飞书侧暴露长连接状态。
change_type: feature
created_in_conversation: 479d3c9a-19c7-468e-a7b6-ec29c3a42c81
capability_test: "n/a: 纯方案设计文档，无 LLM 行为变更；实现阶段的 capability_test 由实现 PR 声明"
tags: [im, weixin, feishu, channel, health, status, ui, refactor]
modules:
  - api-contract/web/pages.ts
  - web/src/pages/im/
  - web/src/components/weixin/
  - web/src/api/client.ts
  - src/usecases/channel/
  - src/frameworks/weixin/polling-channel.ts
  - src/frameworks/feishu/long-connection-client.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/controllers.ts
  - src/bootstrap/server.ts
  - src/interface-adapters/http/controllers/channel-controller.ts
  - src/interface-adapters/http/router.ts
---

# IM 通道统一整合：微信/飞书归一 + 真实健康状态

> **命名决策（搭档 2026-09-11:56 拍板）**：「名字用 IM，不用通道」。
> UI 可见面（TopBar label、页面标题、路由）统一用「IM」；代码层标识符（ChannelStatusRegistry、channelId、ChannelKind）保留 channel——技术概念准确（每通道一个实例），不影响用户可见文案。

## 背景

搭档原话（2026-09-01，对话 479d3c9a）：

> 「微信本质上也是一种im，飞书也是im，所以，是否应该从功能上要整合一下（比如当前是 连接+微信 两个目录）」

> 「我看了眼，本系统的《连接》和《微信》中，还是"已连接"状态，你看下这个是否是代码逻辑有问题」

2026-09-01 上午实测发现的三个问题叠加：

1. **状态失真（bug，本方案主要驱动力）**：《微信》页账号列表纯静态读 `accounts.json`（`weixin-connection-controller.ts:95-103`，`hasToken: Boolean(a.token)` 在 line 103），token 被顶死（实测 `errcode -14 "session timeout"`）后 UI 仍显示"已连接"。轮询层实际知道真相（polling-channel.ts:146-149 吃到 -14 时暂停 1h），但状态从不上报。
2. **目录层积**：飞书是第一代通道（配置藏在 config.yaml，UI 无任何入口），微信是第二代（独立《微信》页 + 扫码）。用户视角"微信和飞书都是 IM"，系统视角却是两套独立页面、两套语义。
3. **"连接"语义撞车**：《连接》页的"已连接"指"海獭进入某个对话会话"（`currentConversation`，IM 大厅，connections/index.tsx:209-215），与《微信》页的"通道已连接"语义完全不同，两个页面共用"已连接"一词表达不同含义。

另实测确认（fact 资源 31f5b3f4，2026-09-01）：ilink bot_token 单实例互斥——同一个微信号的新连接会顶死旧实例 token。多实例部署（如 echo 测试）会踢掉生产 token。这解释了状态失真的真实发生路径。

## 目标

T1: **统一 IM 页**：《连接》+《微信》整合为单一「IM」页，每个通道（飞书/微信）一张卡片，统一三件套——接入引导（扫码/凭证）、真实健康状态、账号管理。
T2: **真实健康状态**：通道卡片显示的状态来自运行时探活上报（轮询层状态），token 失效立即变"token 失效，重新扫码"，不再有静态"已连接"假象。
T3: **通道状态可编程获取**：后端暴露 `/api/channels/status` 聚合端点，为 IM 页及未来接入 RHI 健康面板留出统一接口。
T4: **飞书长连接状态外显**：飞书侧复用已有 WSClient 回调数据（long-connection-client.ts:70-87，4 个回调 onReady/onError/onReconnecting/onReconnected，connectionState/reconnectAttempts 已组装但只打日志），在通道卡片显示 WS 连接状态与重连计数。
T5: **导航收敛**：TopBar 从 8 项收敛为 7 项（连接+微信→IM），《连接》页全部功能平移进 IM 页（见方案设计·页面结构）。

## 非目标

- **不重做 IM 大厅**：《连接》页的对话会话功能（enter/leave/列表）保留原样，仅平移为「IM」页内的一张卡片。理由：那套功能与通道管理正交，重做扩大爆炸半径。
- **不实现飞书扫码**：协议上不存在（飞书机器人是企业自建应用模型——管理员在开放平台建应用、拿 app_id/app_secret、配事件订阅，全是管理端操作，协议上不存在"用户扫码给 bot 授权"路径；飞书 OAuth 扫码是给人登录第三方网站用的，不是 bot 建连）。
- **不改协议层**：ilink 协议、轮询语义、重试/退避策略保持现状。本方案只读状态、不写协议。
- **不接入 RHI 评分**：仅留接口（T3 留口），不把通道健康计入 RHI 五维评分——那需要单独定义评分口径，另起方案。
- **不做多实例互斥检测**：bot_token 被顶是协议行为（单实例语义），本方案只如实显示"token 失效"，不尝试在本地检测"谁顶了我"。
- **不做飞书凭证 UI 编辑**：保持 config.yaml 手工配置现状（理由见设计取舍）。

## 方案设计

### 整体形态：统一「IM」页

```
TopBar: 对话 · 记忆搜索 · 能力库 · IM · 健康面板 · 设置
                                    ↑ 新（连接+微信 合并，命名搭档拍板）
```

页面结构（`/im`，MPA 入口）：

```
┌─────────────────────────────────────────────────┐
│ IM 总览（状态来自 /api/channels/status）         │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │ 微信                  ● 运行中              │ │
│ │ 扫码登录 · 1 个账号 · 上次收消息 10:31       │ │
│ │ [重新扫码] [账号管理 ▾]                      │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ 飞书                  ● WS 已连接 · 0 重连   │ │
│ │ 应用凭证已配置（app_id 掩码显示）             │ │
│ │ [连接测试] [如何配置？]                       │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ IM 大厅（原《连接》页功能平移）              │ │
│ │ 进入对话 · 离开对话 · 会话列表                │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 核心机制：通道状态机（后端）

**新增 `ChannelStatusRegistry`**（`src/usecases/channel/channel-status-registry.ts`，单例，纯内存 Map、无持久化——重启即清零，冷启动后各 poller 重新上报）：

```ts
type ChannelKind = "weixin" | "feishu";
type ChannelRuntimeState =
  | { kind: "starting"; since: number }
  | { kind: "running"; since: number; lastInboundAt?: number; degraded?: boolean }
  | { kind: "token_stale"; since: number; errmsg: string }        // -14：需重新扫码
  | { kind: "error_backoff"; since: number; nextRetryAt: number; errorMsg: string }
  | { kind: "stopped"; since: number; reason: "manual" | "no_config" };

interface ChannelStatusEntry {
  channelId: string;        // "weixin-<accountId>" / "feishu"
  kind: ChannelKind;
  state: ChannelRuntimeState;
  account?: { id: string; nickname?: string };   // weixin 多账号标识
}
```

**谁写状态**：

- 微信轮询循环：`WeixinPollingChannel.loop()` 在关键节点调 `registry.update(channelId, state)`——`start()` 时 starting → 首次成功 getupdates 转 running；-14 时 token_stale；连错进 backoff 时 error_backoff；收到消息时刷新 lastInboundAt；`stop()` 时 stopped。改动点集中在 polling-channel.ts：deps 注入 registry + loop() 内 5 个节点 + start/stop。
- 鬼影轮询回收（#638 修复 4）：`stopStalePollersForUser`（app.ts）回收旧轮询时同步清 registry 对应条目。
- 飞书长连接：`FeishuLongConnectionClient` 现有 4 个回调（long-connection-client.ts:70-87）增加写 registry，映射表：

| WS 回调 | registry 状态 | 说明 |
|---|---|---|
| onReady | running | 首次建连成功 |
| onReconnected | running | 断线重连成功，刷新 since |
| onError | error_backoff | errorMsg = 原始错误 |
| onReconnecting | error_backoff | errorMsg = "WS 重连中"（无已知重试时间，nextRetryAt 省略；UI 按 errorMsg 区分文案） |

  飞书无凭证时 registry 无条目。

**谁读状态**：新增 `GET /api/channels/status`（channel-controller.ts，新文件）：

```jsonc
// 响应示例
{ "channels": [
    { "channelId": "weixin-mtgv10dc", "kind": "weixin",
      "state": { "kind": "token_stale", "since": 1788231415, "errmsg": "session timeout" },
      "account": { "id": "weixin-mtgv10dc" } },
    { "channelId": "feishu", "kind": "feishu",
      "state": { "kind": "running", "since": 1788182784 } }
] }
```

鉴权沿用现状（内网 MPA API 无鉴权，与 /api/weixin/accounts 同口径）。

**新增状态字段消费方声明（issue #379 ⑥）**：本方案不新增数据库 schema 字段（registry 纯内存）；`/api/channels/status` 端点的消费方为 ① IM 页（5s 轮询）② 未来 RHI 通道健康维度（接口预留，本方案不实现评分）。

**静态账号数据与运行态合并**：IM 页需同时展示"有哪些账号"（静态，account-store）与"状态"（运行时，registry）。合并点在 channel-controller：`accountStore.listAccounts()` 逐个 leftJoin registry 条目——有运行条目用运行态；无条目（服务刚重启、轮询未起）显示"未运行"（灰色）。token 死没死一眼可见。

### 状态语义判别表

| 现象 | registry 状态 | UI 展示 | 用户动作 |
|------|--------------|---------|---------|
| 轮询正常收发 | running | ● 运行中 | — |
| #638 降级拉起（有账号无 config 段） | running + degraded | 🟡 降级运行中（config 段缺失） | 参照文档补 config |
| getupdates 吃 -14 | token_stale | 🔴 token 失效，重新扫码 | 点「重新扫码」 |
| 连错 3 次进 backoff | error_backoff | 🟡 网络异常，hh:mm 自动重试 | 等待或查日志 |
| 账号删除/鬼影回收 | 条目移除 | 账号行消失 | — |
| 服务重启后轮询未起 | 无条目 | ⚪ 未运行 | 检查 config 或日志 |
| 无 config 段且降级失败 | stopped(no_config) | ⚪ 配置缺失，未运行 | 补 config 后重启 |
| 轮询正在启动 | starting | 🟡 启动中 | 等待 |

**-14 不细分"过期 vs 被顶"**：协议上 -14 是"session timeout"统称，本地无法区分。统一显示"token 失效，重新扫码"，原始 errmsg 存 registry 备查。

### UI 层：IM 页面（/im）

**新建 `web/src/pages/im/index.tsx`**（入口 im.html，pages.ts 加 entry）：

- **微信卡片**：通道级状态徽标 + 已连接账号列表（含每账号状态）+ 扫码登录入口（QRCodeLoginCard 组件）+ 删除账号。
- **飞书卡片**：凭证状态（读后端——有 appId 即"已配置"，显示掩码；无则"未配置"+ 引导文案与开放平台外链）+ WS 状态 + 「连接测试」按钮（后端调一次 feishu token 接口验证凭证，结果 toast）。
- **会话大厅卡片**：平移原《连接》页的 enter/leave/会话列表（组件级平移，功能不变）。
- 状态轮询：5s 轮询 /api/channels/status（与 health 页刷新节奏一致）。5s 够用：token 失效不需要亚秒级感知。

**导航**：pages.ts 的 MPA_PAGES 删 connections + weixin 两项、加 im 一项（entry `im`，pattern `/im`，label `IM`，位置在「健康面板」前）。vite.config / server.ts / TopBar / 路由测试 4 处自动同步（F20260827mpss 单一真相源）。旧 URL `/connections`、`/weixin` 在 server.ts 静态路由层 301 到 `/im`，防外链断裂。

**旧页面处置（方案 A，见取舍）**：删除 web/src/pages/connections/ + weixin/ 目录，功能全部平移。微信扫码区域抽为独立组件 `web/src/components/weixin/QRCodeLoginCard.tsx` 复用。

### 数据流全景

```
WeixinPollingChannel.loop() ──┐
  (5 状态节点 + start/stop)    │
FeishuLongConnectionClient ───┼─▶ ChannelStatusRegistry ─▶ GET /api/channels/status ─▶ IM 页 5s 轮询
  (WS 回调)                    │       (usecases/channel/)
stopStalePollersForUser ──────┘       bootstrap 注入单例
```

`/api/weixin/accounts` + `/api/weixin/login/*` 端点保留不动（扫码流程已闭环）。`/api/connections/*`（IM 大厅）保留不动。仅新增聚合状态端点。

### 分层落点

| 层 | 文件 | 操作 | 职责 |
|---|---|---|---|
| usecases | src/usecases/channel/channel-status.ts | 新 | 状态实体类型（ChannelRuntimeState/ChannelStatusEntry） |
| usecases | src/usecases/channel/channel-status-registry.ts | 新 | Registry：内存 Map + update/clear/snapshot |
| frameworks/weixin | polling-channel.ts | 改 | deps 注入 registry；loop() 5 节点 + start/stop 上报 |
| frameworks/feishu | long-connection-client.ts | 改 | WS 回调写 registry（connectionState/reconnectAttempts → running/error_backoff 映射） |
| bootstrap | platforms.ts | 改 | 建 registry 单例并注入 weixin/feishu 启动链；startWeixinAccount 拉起先写 starting |
| bootstrap | controllers.ts | 改 | 组装 ChannelController（registry + accountStore + feishu 配置读取） |
| bootstrap | server.ts | 改 | /connections /weixin 旧 URL 301 → /im |
| interface-adapters | http/controllers/channel-controller.ts | 新 | GET /api/channels/status 聚合（registry + accountStore leftJoin） |
| interface-adapters | http/router.ts | 改 | 注册新路由 |
| web | im.html + src/pages/im/index.tsx | 新 | 统一 IM 页 |
| web | src/components/weixin/QRCodeLoginCard.tsx | 新 | 扫码登录卡片（从 weixin 页抽出） |
| web | src/pages/weixin/ + connections/ | 删 | 功能平移后删除（方案 A） |
| web | src/api/client.ts | 改 | getChannelStatus() 封装 |
| contract | api-contract/web/pages.ts | 改 | MPA_PAGES：-connections -weixin +im |

**依赖方向**：registry 类型定义在 usecases 层，frameworks 层构造注入使用（同现有 Logger 端口模式，frameworks → usecases 合规）；channel-controller 依赖 usecases 类型（同现有 controller 模式），无分层违规。

**注入路径（审视补充）**：`platforms.ts` 启动时 `new ChannelStatusRegistry()` 建单例 → 作为字段加入 `startWeixinChannels(options)` 与 `setupFeishu` 的 options → 传入 `startWeixinAccount(options)` → 注入 `WeixinPollingChannel` 构造 deps；飞书侧同样传入 `FeishuLongConnectionClient` 构造参数。`hotStartWeixinAccount`（app.ts 闭包）从 startWeixinChannels 闭包同源传入，保证冷/热启动写同一个 registry 实例。`dispose()` 时 `registry.clear()`（防御性，防未来加事件监听/定时器泄漏；进程退出场景内存自然释放）。

### 与既有机制的关系

- **#638 冷启动降级（F20260831wxsp）**：startWeixinChannels 读到账号但无 config 段时降级拉起并 warn——registry 对应记 running + degraded，UI 显示"降级运行中"。
- **#638 修复 4（鬼影轮询回收）**：stopStalePollersForUser 回收时同步清 registry 条目（双池遍历里加一行）。
- **MPA 单一真相源（F20260827mpss）**：导航增删只改 pages.ts，4 消费方自动同步，无四处手改风险。

## 影响范围

- **用户可见**：TopBar 导航变化（连接+微信 → IM）；旧 URL 301；微信状态从"永远已连接"变为真实状态。
- **/api/weixin/*、/api/connections/***：不动，扫码与会话功能无回归风险。
- **polling-channel.ts**：新增上报调用（纯副作用追加，不改变循环语义与退避策略）；现有 7 例 polling 测试应全绿。
- **feishu long-connection-client.ts**：追加写 registry（不改变连接行为）。
- **删除两个旧页面**：IM 页承接全部功能；唯一不可逆点是旧 URL 依赖（已用 301 兜底）。

## 风险与约束

- **R1 删除旧页面的平移遗漏**：connections/weixin 两页功能点清单（审视核实后逐项）：

  **connections/index.tsx（293 行）**：① 连接列表 + 每连接 currentConversation 状态查询 ② 新建连接表单（name + externalId）③ 进入/离开对话 ④ 当前对话标题展示 ⑤ 加载状态 + 错误 toast（注：无"连接删除"功能，检视清单中该项不存在，已核实全页按钮仅创建/进入/离开）

  **weixin/index.tsx（210 行）**：① 扫码登录发起 + 状态轮询（2s）② 二维码 PNG 渲染 + 过期降级（opacity-40）③ 取消登录 ④ 已登录账号列表 + 删除 ⑤ 扫码成功 toast + 自动刷新 ⑥ 登录会话终态处理（success/expired/error/cancelled）

  平移时逐项打勾，验收标准逐条过。
- **R2 registry 时序竞态**：账号删除瞬间状态查询可能读到已移除条目（可接受的最终一致，5s 轮询自然收敛）。
- **R3 飞书 WS 状态回调覆盖不全**：实现时按注入路径的 4 回调映射表执行；覆盖不到的极端场景保持 running（宁可乐观不可误报死）。
- **R4 glm 配额耗尽（9/4 20:22 重置）**：实现期若遇 429，编码小獭可切 mimo；不影响本方案设计。

## 不兼容更新

[Incompatible] TopBar 导航：`/connections` 与 `/weixin` 页面移除，URL 301 到 `/channels`。书签/外链用户受影响（自动跳转，无功能损失）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| 旧页面处置 | A：删除，功能平移进 channels | B：保留只读遗留视图 | B 造成两套真相源，用户困惑"该看哪个"；A 依赖单一真相源自动同步，风险可控 |
| 状态存储 | 内存 registry（重启清零） | 持久化到 DB | 状态是运行时语义，重启后由各 poller 重新上报即可；持久化引入迁移成本无增益 |
| 状态获取方式 | 5s HTTP 轮询 | SSE/WS 推送 | token 失效无需亚秒感知；本方案不引入新推送机制（复杂度不匹配收益） |
| 飞书凭证 UI 编辑 | 不做，保持 config.yaml | UI 表单编辑 | 低频管理操作，UI 化收益低；app_secret 表单落库涉及安全设计，另案处理 |
| token 失效细分 | 不区分"过期 vs 被顶" | 本地检测被顶 | 协议无区分语义（-14 统称 session timeout）；检测成本高且不可靠 |
| 会话大厅形态 | IM 页内卡片 | 保留连接页独立入口 | 搭档原话"整合一下（比如当前是 连接+微信 两个目录）"指向目录整合，保留独立入口与初衷相悖 |
| 页面结构 | 单页纵向 3 卡片 | Tab 切换 | 3 卡片信息量小，滚动即可；与 health 页卡片风格一致 |

## 审视决策史（第一轮，检视獭-通道整合 mimo，2026-09-01）

0 严重 / 5 建议，逐条处置：

| 发现 | 处置 | 理由 |
|---|---|---|
| 1. file:line 引用偏 3 处 | 接受并修订 | 核实属实（-14 实际 146-149、hasToken 在 103、飞书回调在 70-87），修正后实现者零搜索成本 |
| 2. 平移清单缺逐项功能点 | 部分接受 | 清单补入 R1（修正了检视清单中的错误项：connections 页无"连接删除"功能，已核实全页按钮仅创建/进入/离开）；但清单本身写入方案而非建 issue——它是验收标准的一部分，跟着文档走比跟着 issue 走更近 |
| 3. registry 注入路径未展开 | 接受并修订 | 补注入路径段（冷/热启动同源 + dispose clear），2-3 行成本消歧义 |
| 4. 飞书 4 回调映射未明确 | 接受并修订 | 补映射表；onReconnecting → error_backoff(errorMsg="WS 重连中")，不为它单加第六态——重连中本质是"带错误信息的等待"，与 backoff 语义同构 |
| 5. registry dispose 无清理 | 接受并修订 | 补 dispose() 清 registry.clear()；HMR 场景现阶段不存在，但一行成本防御 |

## 验证

### 验收标准

1. TopBar 显示「IM」，不再显示「连接」「微信」；旧 URL /connections、/weixin 301 → /im。
2. 微信 token 正常时显示「● 运行中」；token 失效（-14）后 ≤5s 页面显示「🔴 token 失效，重新扫码」（原状：永远显示已连接）。
3. token_stale 后点「重新扫码」，登录成功状态转回 running（#638 热启动 + registry 更新联动）。
4. 飞书无凭证显示「未配置」+ 引导；有凭证显示 WS 状态 + 重连数；「连接测试」可验证凭证有效性。
5. 会话大厅功能无回归：列表/进入/离开/创建连接全可用。
6. /api/channels/status 返回 weixin 各账号 + feishu 聚合状态；无运行条目的账号显示"未运行"。

### 测试设计

- **单元**：ChannelStatusRegistry（update/snapshot/clear 时序）；polling-channel 状态上报（fake registry 收集副作用——沿用 #638 的副作用断言风格）；channel-controller leftJoin 合并逻辑。
- **集成**：server 静态路由（channels 注册 + 旧 URL 301）；pages.ts MPA_PAGES 守卫测试自动覆盖新入口；registry 单例冷/热启动同源（hotStartWeixinAccount 写入与冷启动同一实例）。
- **手动验收**：真实 token 失效场景（拔掉 config 或等 -14）观察 UI 转红；扫码恢复转绿；飞书断网/恢复观察 onReconnecting→onReconnected 状态往返。
- **平移验收**：R1 清单逐项打勾（connections 5 项 + weixin 6 项）。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| api-contract/web/pages.ts | 改 | MPA_PAGES 增删 |
| web/im.html | 新 | 页面入口 |
| web/src/pages/im/index.tsx | 新 | 统一 IM 页（微信+飞书+会话大厅 3 卡片） |
| web/src/components/weixin/QRCodeLoginCard.tsx | 新 | 扫码登录卡片组件（自 weixin 页抽出） |
| web/src/pages/weixin/ | 删 | 功能平移后删除 |
| web/src/pages/connections/ | 删 | 功能平移后删除 |
| web/src/api/client.ts | 改 | 新增 getChannelStatus() |
| src/usecases/channel/channel-status.ts | 新 | 状态实体类型 |
| src/usecases/channel/channel-status-registry.ts | 新 | 状态注册表 |
| src/frameworks/weixin/polling-channel.ts | 改 | 状态上报（deps 注入 + loop 节点） |
| src/frameworks/feishu/long-connection-client.ts | 改 | WS 状态上报 |
| src/bootstrap/platforms.ts | 改 | registry 单例注入启动链 |
| src/bootstrap/controllers.ts | 改 | 组装 ChannelController |
| src/bootstrap/server.ts | 改 | 旧 URL 301 |
| src/interface-adapters/http/controllers/channel-controller.ts | 新 | 聚合状态端点 |
| src/interface-adapters/http/router.ts | 改 | 注册路由 |
