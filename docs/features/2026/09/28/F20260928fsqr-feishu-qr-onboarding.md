---
id: F20260928fsqr
summary: 飞书接入改造——SDK registerApp 扫码自动建 app 免 ak/sk，多账号多 WS 并行，对齐微信 clawbot 模式
title: 飞书扫码接入：registerApp 免凭证建线
feature_id: F20260928fsqr
created: 2026-09-28
created_in_conversation: 8c447618-ef7a-4b21-8b01-45c6ebff138b
change_type: feature
capability_test: "n/a: 方案阶段文档（实现 PR 落地时补 login-session-manager 状态机与 app-store CRUD 的测试路径）"
tags: [im, feishu, qr-login, registerApp, multi-app]
modules: [src/frameworks/feishu/, src/interface-adapters/feishu/, src/interface-adapters/http/controllers/, src/bootstrap/, web/src/pages/im/, web/src/components/feishu/]
causal_links:
  - F20260918imas（p2p 自动开户）
  - F20260920imax（bot 锚定路由 + 助理线）
  - F20260928wxid（PartnerResolver 多渠道 + 微信扫码自报称呼——交互对齐）
  - issue #565（微信通道先例：扫码 + 账号化 + 多连接生命周期）
---

# 飞书扫码接入：registerApp 免凭证建线

## 背景

搭档原话（意图锚）：
> 「你现在来改造飞书接入，我跟同事确认了，飞书就是有提供 扫码接入飞书bot的能力，不要再让我填一堆ak/sk什么的了，你去确认下飞书扫码接入机器人方式」
> 「你去看下echo项目里的飞书接入吧」

现状：飞书通道要求部署者在 config.yaml 手填 `feishu.appId/appSecret`（config-service.ts:530 校验必填），单应用单 WS 长连接（platforms.ts:390 启动装配）。用户体验与微信 clawbot（扫码即用，issue #565）不对齐。

调研结论（2026-09-28，双源核实）：
1. **SDK `registerApp` 通道存在且可用**——`@larksuiteoapi/node-sdk` 1.73.3（本仓在用版本，零升级）内含 `registerApp()`：RFC 8628 设备授权流（`accounts.feishu.cn/oauth/v1/app/registration`，`archetype: 'PersonalAgent'`），服务端 begin → 拿二维码 URL → 用户飞书扫码 → 落地页确认「创建应用」→ 轮询返回 `{client_id, client_secret, user_info.open_id}`。锚点：EchoAgent `dev/backend/src/modules/im-connectors/adapters/feishu/feishu-login.ts`（完整生产实现）；SDK types/index.d.ts:321953-321998。
2. **EchoAgent 已验证该模式**：扫码拿凭证 → `createLarkChannel(appId, appSecret)` WS 长连接收发（dmMode 'open' p2p 免 @）。ownerOpenId 与入站 senderOpenId 同一套 open_id。
3. 上轮调研修正：我此前仅查开放平台文档站得出「ak/sk 省不掉」是**错的**——SDK 内嵌通道文档站没有独立页面，EchoAgent 实现是决定性证据。

## 目标

- T1: 飞书接入对齐微信扫码体验——IM 页点「扫码接入」→ 飞书扫码确认 → 自动建 app + 起助理线，全程不碰 ak/sk
- T2: 多扫码账号并存——每个扫码的 app 一条 WS 长连接，独立生命周期（启停/删除/重启恢复）
- T3: 扫码建线人即搭档——ownerOpenId 锚定 partnerResolver（承接 F20260928wxid 多渠道构造），助理线语义与微信侧一致
- T4: 存量兼容——config.yaml 静态单 app 模式继续工作，扫码账号是并行增量入口

## 非目标

- 不做飞书群聊多租户管理界面（现有 bot 锚定路由 F20260920imax 维持）
- 不迁移/废弃存量 config.yaml 飞书配置
- 不做 app 权限模板自定义（registerApp 默认 PersonalAgent 模板，EchoAgent 同款零 addons）
- 不动微信侧任何代码

## 未决问题

1. registerApp 默认 PersonalAgent 模板的权限边界（是否含 im:message 收发全套）——EchoAgent 生产在用说明够用（`createLarkChannel` dmMode:'open' + requireMention:true 群聊可用），本仓实现时以实测为准，若 p2p 收不到消息再补 `addons.scopes` 声明
2. 同一用户重复扫码 = 建新 app 还是绑定旧 app（SDK `appId`/`createOnly` 参数支持两种流）——默认 createOnly 式新建（防误绑覆盖既有 webhook 配置，SDK 注释明示该风险），重复扫码产生多 app 属可接受冗余，账号卡可删

## 方案设计

### 架构总览：微信通道模式的三通道同构（第三通道账号化）

```
前端 IM 页                后端                              飞书
┌──────────┐   POST /api/feishu/login   ┌─────────────────┐
│ 起名+扫码  │ ─────────────────────────> │ FeishuLogin     │
│ QRCodeCard│ <───── qrcodePng 轮询 ──── │ SessionManager  │──registerApp──> accounts.feishu.cn
└──────────┘                            │ (新)            │<──appId/secret──
                                        └───────┬─────────┘
                                                │ onSuccess
                                   ┌────────────┼────────────────┐
                                   ▼            ▼                ▼
                          FeishuAppStore   provisionLine   startAppRuntime
                          (新,落盘)       (开助理线)      (起WS,复用现有装配)
```

### 模块清单

| 模块 | 文件 | 说明 |
|---|---|---|
| 凭据存储 | `src/frameworks/feishu/app-store.ts`（新） | 模仿 WeixinAccountStore：`<stateDir>/feishu-apps.json`，`{ appId → {appSecret, ownerOpenId, name, addedAt} }`；save/delete/list |
| 登录会话 | `src/frameworks/feishu/login-session-manager.ts`（新） | 包 SDK registerApp：start（begin+二维码 URL→png base64）/ get / cancel；状态机 pending→waiting_scan→success/error/expired；10min 过期清理。二维码渲染用 `qrcode` npm 包（服务端 URL→png base64，对齐微信 DTO 形态，前端零新依赖） |
| HTTP 端点 | `src/interface-adapters/http/controllers/feishu-connection-controller.ts`（新） | `POST /api/feishu/login`、`GET /api/feishu/login/:id`、`POST /api/feishu/login/:id/cancel`、`GET /api/feishu/apps`（账号列表+助理线投影）、`DELETE /api/feishu/apps/:id`（停 WS+删store+释放绑定）。对齐 weixin-connection-controller.ts 全套语义（#891 safeJsonBody 防御、错误文案映射 describeFeishuQrFailure 模式照搬 EchoAgent——不透传第三方原文） |
| 运行时工厂 | `src/bootstrap/platforms.ts` 改造 | 抽 `buildFeishuRuntime(appId, appSecret, ...) → {stop}`：内部 new FeishuAccessTokenManager + FeishuClient + FeishuLongConnectionClient + FeishuMessageProcessor + handler 装配（现有 380-405 行段提参化）；config 静态 app 调一次，扫码 apps 各调一次 |
| 扫码账号启动 | `startFeishuScanChannels`（platforms.ts 新导出） | app.ts 启动时遍历 FeishuAppStore.list() 逐个 buildFeishuRuntime；返回 stop 全体句柄接入 dispose 链（#460 同款） |
| 助理线开通 | app.ts 闭包注入（对齐 provisionWeixinAssistantLine 模式） | 扫码 onSuccess：ensureConnection(`feishu-bot:${appId}`) → 开 assistant 对话 → noteChatId(ownerOpenId 不可用——p2p chatId 在首条消息时回填)；owner 首条 p2p 消息走现有 F20260920imax 链路自动定向 |
| PartnerResolver | platforms.ts 装配点 | 扫码 apps 的 ownerOpenId 并入 rest 多渠道构造（F20260928wxid 刚建的能力）；命令门禁维持单渠道锚不动 |
| 前端 | `web/src/components/feishu/FeishuQRCodeLoginCard.tsx`（新）+ IM 页飞书卡改造 | 复制 QRCodeLoginCard 骨架（两步：起名→扫码，2s 轮询，状态七态映射）；飞书卡未配置时展示扫码入口，已配置时追加「添加扫码账号」 |
| DTO | `web/src/api/client.ts` | FeishuLoginSessionDTO 对齐 WeixinLoginSessionDTO 形态（id/status/qrcodePng/error） |

### 关键设计决策

**D1 每条 WS 一套独立装配**（非共享 tokenManager）：多 app 各自凭证各自连接，FeishuAccessTokenManager 实例隔离。理由：token 域按 app 隔离是飞书机制（app_id+secret 换 tenant_access_token），共享无收益且引入串扰面。

**D2 二维码服务端渲染**（URL→png base64）：前端已有 `<img src={base64}>` 渲染路径（QRCodeLoginCard.tsx:117），后端 `qrcode` 包转 png 后 DTO 形态与微信完全一致，前端组件近乎复制。替代方案（前端 qrcode.react 渲染 URL）被否——引入新依赖+新渲染分支，与微信组件形态分叉。

**D3 registerApp 走 createOnly 语义**（每次扫码建新 app）：SDK 注释明示绑定既有 app 会覆盖其 webhook 配置（风险源）；重复扫码建多 app 属可接受冗余，账号卡删除入口兜底。

**D4 凭据存文件非 DB**（对齐微信 accounts.json 先例）：connections 表是路由锚（externalId=bot键），凭据是运行时密钥（含 secret），混入 DB 无消费方且扩大暴露面。app-store 文件权限同 weixin stateDir。

**D5 存量静态 app 与扫码 apps 并行**：config.yaml 配了就走现有单 app 路径（零改动），扫码 apps 走新路径。两路径共用 buildFeishuRuntime 工厂消除装配重复。

### 机制识别检查点（命中申报）

- [x] 新增状态生命周期：登录会话（pending→waiting_scan→success/error/expired，10min TTL）+ 扫码 app 运行时（starting→online→reconnecting→stopped）
- [x] 新增持久化存储：feishu-apps.json（凭据文件）
- [x] 新增决策分支：扫码 onSuccess 落库+provision+起 WS；DELETE 停线
- [x] 新增跨模块调用路径：controller→login-manager→app-store→platforms 运行时
- [x] 新增后台进程：每 app 一条 WS 长连接
- [ ] 新增配置字段/枚举：否（复用 connections.metadata + 现有 FeishuConfig 可选化）
- [ ] 新增信号类型：否

→ 判定：**涉及净新增机制**，机制预算四问必答（见下）+ 重对抗门。

### 机制预算四问

**① 谁需要它**：搭档（部署者）——产品语义已定「不要填 ak/sk」（原话锚）；延伸到未来扫码即用的终端用户（每人一线，微信侧已验证的产品形态）。

**② 失败后果**：扫码失败用户立即可见（会话 error 态+确定文案映射）；app 凭证被用户在开放平台删除 → WS 报错 → registry error_backoff 红牌（F20260901chun 状态链已有）+ 账号卡删除入口；最坏情况：app 建成但 onSuccess 落库前进程崩溃 → 飞书侧多一个孤儿 app，用户可在开放平台删除，无数据损失。

**③ 后续机制**：新状态里会出错的——登录会话超时（10min 清理，微信同款）；WS 断连重连（SDK 内置+registry 展示）；secret 轮换（飞书侧重置 secret → 连接报错 → 用户删除重扫，账号卡引导）。修法都是既有模式（微信通道先例）。

**④ 退役条件**：飞书开放平台提供协议级免应用 bot（clawbot 形态），或项目放弃飞书通道——届时 feishu-apps.json + 登录会话 + 多连接启动整段下线，存量静态 app 路径不受影响。

### 数据流（扫码成功关键序列）

```
onSuccess({appId, appSecret, ownerOpenId})
  → appStore.save(appId, {appSecret, ownerOpenId, name: 起名})
  → ensureConnection(`feishu-bot:${appId}`, name) → conversation 开线（assistant kind）
  → buildFeishuRuntime(appId, appSecret) 起 WS → registry 注册
  → 前端轮询到 success → 账号卡刷新（appIdMasked + 助理线标题）
用户首条 p2p 消息 → FeishuMessageProcessor（现有链）→ bot 锚定路由 → 助理对话 → 海獭回复 → noteChatId 回填
```

## 影响范围

- platforms.ts 装配段重构（提工厂函数）——存量静态 app 路径行为等价，测试覆盖
- app.ts：新增 startFeishuScanChannels 接入启动/dispose 链
- PartnerResolver 装配：扫码 ownerOpenId 并入（dispatch 身份判定增强，门禁不动）
- IM 页飞书卡：新增扫码入口与账号列表（已配置态追加，不破坏现有显示）
- 不动：微信全部、飞书 message-processor/long-connection-handler 核心逻辑、dispatch-chain-engine

## 风险与约束

- **registerApp 是 SDK 较新能力**（1.73.x 加入）：本仓与 EchoAgent 同版本 1.73.3 已验证在用；灰度面（如 addons 平台开关）不依赖——零 addons 走默认模板
- **多 WS 连接资源**：每 app 一条 WS + 一个 token 定时刷新，量级 = 扫码人数（个位数），可接受
- **secret 落盘安全**：feishu-apps.json 含 secret，与微信 accounts.json 同级暴露面（stateDir 本地权限）；不上 git（stateDir 在 data/ 已 ignore）
- **飞书 app 数量上限**：单租户自建应用数量有限额（文档未见硬数字，EchoAgent 模式未遇限），重复扫码冗余 app 靠删除入口收敛

## 不兼容更新

无。[Incompatible] 无标注项。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 每条 WS 独立装配 | D1 独立 tokenManager/Client | 共享单例多路复用 | 飞书 token 按 app 域隔离，共享无收益有串扰 |
| 二维码渲染 | D2 服务端 png base64 | 前端 qrcode.react | DTO 与微信全同，前端组件复制，零新依赖 |
| 重复扫码 | D3 每次建新 app | 绑定旧 app 更新 | SDK 注释明示绑定覆盖 webhook 的风险；冗余可删 |
| 凭据存储 | D4 文件（accounts 同构） | connections 表加列 | 密钥不入 DB（暴露面），DB 无消费方 |
| 存量模式 | D5 并行保留 | 强制迁移扫码 | 存量零风险；迁移无收益 |
| 助理线开通时机 | 扫码即开（provision） | 首条消息再开 | 对齐微信「扫码即建线」体验；p2p 首消息链路本就存在，provision 是提前占位 |

省事声明审计：本方案「对齐微信模式复制组件」类表述——省掉的是前端交互设计与状态机设计的从零成本，代价由「微信/飞书组件相似但不共享」承担（两份代码各自演化），主人明确（本项目 IM 页已接受 QRCodeLoginCard 单例形态，复制是既定模式而非新债）。

## 验证

- 单测：login-session-manager 状态机（start/get/cancel/过期）+ app-store CRUD + controller 端点（#891 防御）+ buildFeishuRuntime 工厂装配（mock WSClient）
- 集成：扫码 onSuccess 全链（mock registerApp）→ store 落库 → connection 建线 → runtime 注册 registry
- 存量回归：config.yaml 静态 app 路径测试全绿（装配重构等价性）
- 手测清单：真机扫码 → p2p 对话 → 海獭回复带 [搭档(称呼)]（F20260928wxid 链路）→ 删除账号 → WS 停止

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/feishu/app-store.ts | 新增 | 凭据落盘 |
| src/frameworks/feishu/login-session-manager.ts | 新增 | registerApp 包装+状态机 |
| src/frameworks/feishu/qr-renderer.ts | 新增 | URL→png base64（qrcode 包） |
| src/interface-adapters/http/controllers/feishu-connection-controller.ts | 新增 | 登录/账号管理端点 |
| src/bootstrap/platforms.ts | 修改 | 装配段提工厂 + startFeishuScanChannels |
| src/bootstrap/controllers.ts | 修改 | 注册新 controller |
| src/app.ts | 修改 | 扫码通道启动/dispose + provision 闭包 |
| package.json | 修改 | +qrcode（+@types/qrcode） |
| web/src/components/feishu/FeishuQRCodeLoginCard.tsx | 新增 | 扫码组件（微信组件同构） |
| web/src/pages/im/index.tsx | 修改 | 飞书卡扫码入口+账号列表 |
| web/src/api/client.ts | 修改 | DTO + API 函数 |
| docs/features/2026/09/28/F20260928fsqr-feishu-qr-onboarding.md | 本文档 | — |
