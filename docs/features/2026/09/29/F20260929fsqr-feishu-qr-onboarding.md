---
id: F20260929fsqr
summary: 飞书接入改造——SDK registerApp 扫码自动建 app 免 ak/sk，多账号多 WS 并行，对齐微信 clawbot 模式
title: 飞书扫码接入：registerApp 免凭证建线
feature_id: F20260929fsqr
created: 2026-09-28
created_in_conversation: 8c447618-ef7a-4b21-8b01-45c6ebff138b
change_type: feature
capability_test: tests/frameworks/feishu/feishu-qr-onboarding.test.ts
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
- T3: 扫码建线人身份链——首个扫码人 ownerOpenId 运行时写入全局 PartnerResolver（先写先得，对齐微信 ensureWeixinConfig 幂等语义）；其余扫码人是「线 owner」（metadata.ownerOpenId 落库，称呼链用）；多账号全量每线搭档语义记遗留（与 #1188 同根因聚合）
- T4: 存量兼容——config.yaml 静态单 app 模式继续工作，扫码账号是并行增量入口

## 非目标

- 不做飞书群聊多租户管理界面（现有 bot 锚定路由 F20260920imax 维持）
- 不迁移/废弃存量 config.yaml 飞书配置
- 不做 app 权限模板自定义（registerApp 默认 PersonalAgent 模板，EchoAgent 同款零 addons）
- 不动微信侧任何代码

## 未决问题

1. registerApp 默认 PersonalAgent 模板的权限边界（是否含 im:message 收发全套）——EchoAgent 生产在用说明够用，但属对方部署事实未交叉验证；本仓实现时**实测清单必过**：p2p 收发 / 群 @ 收发 / 事件到达 WS 三项；若实测失败，兜底是「app 建成后在租户开放平台控制台手动调权限与事件订阅」（addons.scopes 参数依赖平台灰度，SDK 注释明示非灰度时整个参数被忽略，不可依赖）
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
| 键派生 | `src/frameworks/feishu/bot-key.ts`（新） | **审改：统一键源**——`botKey(appId) = \`feishu-bot:${maskAppId(appId)}\``，复用 long-connection-client 的 maskAppId；provision/DELETE/入站三处同源派生，杜绝建线键与路由锚分裂（F20260921wxba 教训）。注意：maskAppId 掩码键兼任身份键有理论碰撞面（首5尾4），个位数 app 量级可接受，注记留此 |
| 凭据存储 | `src/frameworks/feishu/app-store.ts`（新） | 模仿 WeixinAccountStore：`<stateDir>/feishu-apps.json`，`{ appId → {appSecret, ownerOpenId, name, addedAt} }`；save/delete/list |
| 登录会话 | `src/frameworks/feishu/login-session-manager.ts`（新） | 包 SDK registerApp：start（begin+二维码 URL→png base64，**起名流入 appPreset.name**（EchoAgent 同构 feishu-login.ts:50-51，扫码确认页应用名有语义））/ get / cancel；状态机 pending→waiting_scan→success/error/expired（**SDK 无 scanned 态**——onStatusChange 仅 polling/slow_down/domain_switched，与微信七态不同，前端映射按实际六态）；10min 过期清理。二维码渲染用 `qrcode` npm 包（已在依赖，微信 login-session-manager 现用） |
| HTTP 端点 | `src/interface-adapters/http/controllers/feishu-connection-controller.ts`（新） | `POST /api/feishu/login`、`GET /api/feishu/login/:id`、`POST /api/feishu/login/:id/cancel`、`GET /api/feishu/apps`（账号列表+助理线投影）、`DELETE /api/feishu/apps/:id`（停 WS+unregister+删store+释放绑定）、**`POST /api/feishu/apps/:id/assistant-line`（幂等 provision 独立端点，对齐微信 weixin-connection-controller.ts:120 先例，失败可重试）**；safeJsonBody 防御、错误文案映射 describeFeishuQrFailure 模式照搬 EchoAgent |
| 出站通道 | `src/usecases/im/feishu-message-channel.ts` 改造 | **审改：键控出站（#591 同构）**——归属过滤从「externalType === feishu」升级为「externalType === feishu 且 externalId === 本通道 botKey」；构造注入 botKey；多通道注册后广播互不串扰 |
| 运行时工厂 | `src/bootstrap/platforms.ts` 改造 | **审改（delta 修正）**：工厂吸收 createFeishuBundle（:310-328，client/tokenManager/出站注册）+ setupFeishu（:341-414，commandDispatcher/partnerResolver/messageProcessor/longConnection）两段：抽 `buildFeishuRuntime(appId, appSecret, ...) → {stop, botKey}`；**出站注册键控化** `messageBroadcaster.registerOutboundChannel(botKey, channel)`（delta：直接用 botKey 做键，无双重前缀；静态 config app 同款改造；key 仅运行时注册表不落库，无兼容负担）；DELETE/dispose 时 unregister 成对清理 |
| 运行时注册表 | `src/app.ts`（新 Map） | **审改（建议 4）**：`feishuRuntimes: Map<appId, {stop, botKey}>`——boot 遍历 appStore 与 onSuccess 两源统一入表，DELETE/销毁链两路成对清理（#460 dispose 链接入） |
| 扫码账号启动 | `startFeishuScanChannels`（platforms.ts 新导出） | app.ts 启动时遍历 FeishuAppStore.list() 逐个 buildFeishuRuntime；返回 stop 全体句柄接入 dispose 链 |
| 助理线开通 | `POST /api/feishu/apps/:id/assistant-line`（幂等端点，app.ts 闭包注入） | **审改（建议 6）**：拆独立幂等端点；扫码 onSuccess 只做 save+start（轻量），provision 由 onSuccess 自动触发一次但失败不阻建 app，账号卡「补建线」入口兼做重试通道；建线键用 botKey(appId)（**掩码形态**，与入站路由锚同源）→ 开 assistant 对话 → noteChatId 首消息回填 |
| PartnerResolver | `src/usecases/im/partner-resolver.ts` 改造 + platforms.ts 装配 | **审改（严重 3 + delta 必修）**：加 `addPartnerId(id)` 可变方法（幂等）——扫码 onSuccess 时首个 ownerOpenId 先写先得写入（微信 ensureWeixinConfig 同构语义，供 dispatch 渲染链）；**命令门禁锚每线构造**：buildFeishuRuntime 内 `new PartnerResolver(线ownerOpenId, 首号ownerOpenId?)`（D7 双锚，纯扫码主路径不落入 configured=false 全开分支）；DELETE 不回收全局锚（记遗留，避免首账号删除后链路摇摆）；dispatch 渲染装配点（多渠道构造）同实例共享 |
| 前端 | `web/src/components/feishu/FeishuQRCodeLoginCard.tsx`（新）+ IM 页飞书卡改造 | 复制 QRCodeLoginCard 骨架（两步：起名→扫码，2s 轮询）；状态映射按飞书实际（无 scanned 态）；飞书卡未配置时展示扫码入口，已配置时追加「添加扫码账号」 |
| 同号提示 | 前端 FeishuQRCodeLoginCard | onSuccess 后查同 owner 已有 app → 前端「已有助理线 X，确认再建？」确认框（建议 3 顺手做）；**拒绝路径（delta B）**：调用 `DELETE /api/feishu/apps/:id` 自动删除刚建 app（含停 WS+释放，无孤儿 app） |
| 状态投影 | `src/interface-adapters/http/controllers/channel-controller.ts` + web IM 页 | **审改（建议 4）**：channel-status 多实例化——feishu 扫码线各报 kind=botKey（delta：出站键同源，无双重前缀；或 instances 数组，实现时按现有 registry 结构定）；IM 页 \`find(kind==='feishu')\` 取首处同步适配 |
| DTO | `web/src/api/client.ts` | FeishuLoginSessionDTO 对齐 WeixinLoginSessionDTO 形态（id/status/qrcodePng/error），status 枚举差异（无 scanned）显式声明 |

### 关键设计决策

**D1 每条 WS 一套独立装配**（非共享 tokenManager）：多 app 各自凭证各自连接，FeishuAccessTokenManager 实例隔离。理由：token 域按 app 隔离是飞书机制（app_id+secret 换 tenant_access_token），共享无收益且引入串扰面。

**D2 二维码服务端渲染**（URL→png base64）：前端已有 `<img src={base64}>` 渲染路径（QRCodeLoginCard.tsx:117），后端 `qrcode` 包转 png 后 DTO 形态与微信完全一致，前端组件近乎复制。替代方案（前端 qrcode.react 渲染 URL）被否——引入新依赖+新渲染分支，与微信组件形态分叉。

**D3 registerApp 走 createOnly 语义**（每次扫码建新 app）：SDK 注释明示绑定既有 app 会覆盖其 webhook 配置（风险源）；重复扫码建多 app 属可接受冗余，账号卡删除入口兜底。

**D4 凭据存文件非 DB**（对齐微信 accounts.json 先例）：connections 表是路由锚（externalId=bot键），凭据是运行时密钥（含 secret），混入 DB 无消费方且扩大暴露面。app-store 文件权限同 weixin stateDir。

**D5 存量静态 app 与扫码 apps 并行**：config.yaml 配了就走现有单 app 路径（键控出站改造同段，行为等价），扫码 apps 走新路径。两路径共用 buildFeishuRuntime 工厂消除装配重复。

**D6 建线键统一从 botKey 派生（审改，严重 1）**：入站路由锚是 `feishu-bot:${maskAppId(appId)}`（client.ts:23，#663 掩码），provision/DELETE/入站必须同源——抽 bot-key.ts 共享 helper，三处消费。不改存量锚格式（存量线 externalId 已是掩码形态，改格式会孤儿化）。

**D7 首个扫码人先写先得全局搭档锚 + 每线 owner 命令门禁锚（delta 复核修订）**：「谁是搭档」分两层——**称谓语义**全局首号（对齐微信 ensureWeixinConfig 先写先得）：首个扫码人 ownerOpenId 经 PartnerResolver.addPartnerId 运行时写入，后续扫码人是线 owner（metadata 落库供称呼链）；**操作语义每线**：命令门禁 resolver 每线独立构造 `new PartnerResolver(线ownerOpenId, 首号ownerOpenId?)` 双锚——线主人在自己线上可跑命令，首号（部署者）任意线上可跑，陌生人被拦（message-processor.ts:165 门禁在 configured=false 时全开，纯扫码主路径必须有锚；同渠道多锚不违反 wxid 跨渠道不变量）。多账号全量每线搭档**称谓**语义记遗留（与 #1188 同根因聚合）。理由：本产品当前实际形态是「部署者自用 + 家人/同事小范围」（微信侧同款先例），首号称谓锚最贴近现状；每线命令锚是安全底线不可降级。

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

**② 失败后果**：扫码失败用户立即可见（会话 error 态+确定文案映射）；app 凭据被用户在开放平台删除 → WS 报错 → registry error_backoff 红牌（F20260901chun 状态链已有）+ 账号卡删除入口；**半成品态**（落库成功但 provision/出站/WS 部分失败）：provision 独立幂等端点可重试（账号卡「补建线」入口）、WS 失败 registry 示红可重试起、出站键控隔离失败不扩散；最坏情况：app 建成但 onSuccess 落库前进程崩溃 → 飞书侧多一个孤儿 app，用户可在开放平台删除，无数据损失。

**③ 后续机制**：新状态里会出错的——登录会话超时（10min 清理，微信同款）；WS 断连重连（SDK 内置+registry 展示）；secret 轮换（飞书侧重置 secret → 连接报错 → 用户删除重扫，账号卡引导）。**配套复杂度已计入方案面**（非「既有模式顺手就行」）：键控出站（#591 同构——出站通道按 botKey 归属过滤+成对清理）、防复活（#592 同构——DELETE 停 WS+unregister+删 store 三步原子序）、无冗余 hook（#682 同构——运行时注册表单一入口）——三者均已入模块清单。

**④ 退役条件**：飞书开放平台提供协议级免应用 bot（clawbot 形态），或项目放弃飞书通道——届时 feishu-apps.json + 登录会话 + 多连接启动整段下线，存量静态 app 路径不受影响。

### 数据流（扫码成功关键序列）

```
onSuccess({appId, appSecret, ownerOpenId})
  → appStore.save(appId, {appSecret, ownerOpenId, name: 起名})
  → partnerResolver.addPartnerId(ownerOpenId)   // 仅首个，先写先得（D7）
  → buildFeishuRuntime(appId, appSecret) 起 WS → registry 注册 → 入运行时表
  → provision 助理线（幂等端点自动触发一次，失败可重试）：
      ensureConnection(botKey(appId), name) → conversation 开线（assistant kind）
      metadata.ownerOpenId 落库（称呼链用；缺失时首条 p2p 消息 sender 回填，与 noteChatId 同位）
用户首条 p2p 消息 → FeishuMessageProcessor（现有链）→ bot 锚定路由（同 botKey 命中）→ 助理对话 → 海獭回复 → 出站通道按 externalId===botKey 定向投递 → noteChatId 回填
```

## 影响范围

- platforms.ts 装配段重构（提工厂函数）——存量静态 app 路径行为等价，测试覆盖
- app.ts：新增 startFeishuScanChannels 接入启动/dispose 链
- PartnerResolver 装配：扫码 ownerOpenId 并入（dispatch 身份判定增强，门禁不动）
- IM 页飞书卡：新增扫码入口与账号列表（已配置态追加，不破坏现有显示）
- 不动：微信全部、飞书 message-processor/long-connection-handler 核心逻辑、dispatch-chain-engine

## 风险与约束

- **registerApp 是 SDK 较新能力**（1.73.x 加入）：本仓与 EchoAgent 同版本 1.73.3 已验证在用；addons 参数依赖平台灰度不可依赖，兜底走控制台手调（未决 1）；EchoAgent 生产可用属对方部署事实，本仓实现必过实测三清单
- **多 WS 连接资源**：每 app 一条 WS + 一个 token 定时刷新，量级 = 扫码人数（个位数），可接受
- **secret 落盘安全**：feishu-apps.json 含 secret，与微信 accounts.json 同级暴露面（stateDir 本地权限）；不上 git（stateDir 在 data/ 已 ignore）
- **飞书 app 数量上限**：单租户自建应用数量有限额（文档未见硬数字，EchoAgent 模式未遇限），重复扫码冗余 app 靠删除入口收敛
- **掩码键碰撞**（检视观察）：首5尾4掩码在个位数 app 下碰撞概率极低，接受；若未来 app 数量级增长，升级 bot-key 派生规则（注记在 bot-key.ts）

## 已知遗留（审视后新增）

- 多账号「每线各自认定搭档」语义（与 #1188 同根因：多账号搭档错认）——D7 首号锚是当前形态的解，每线语义留待多家庭部署需求出现时升级
- PartnerResolver addPartnerId 后不回收（首账号 DELETE 后锚仍在）——避免摇摆，记遗留
- 门禁锚双缺席面（代码审视建议⑤）：线 ownerOpenId 与 config.feishu.partnerOpenId 均缺失时，该线门禁 configured=false 不拦截——已做单级退避（owner 缺失退 config 锚），纯扫码且 owner 从未回填的极端窗口才有此面，待门禁默认拒绝语义升级
- 同号扫码提示与拒绝路径未实现（重复扫码建新 app，删除入口/开放平台手动删兑底）——低频顺手项

### 代码审视处置记录（代码检视獭，7 严重 + 6 建议 + delta 轮）

| 发现 | 级别 | 处置 |
|---|---|---|
| 静态 app 出站双注册（重复投递） | 严重 | ✅ createFeishuBundle 注册行删除，工厂单点注册 |
| channel-status 投影断裂 | 严重 | ✅ 静态 channelKey:"feishu" 保持 + feishu-bot: 前缀多实例投影 |
| 掩码 appId 端点断链 | 严重 | ✅ getAppByMaskedId 单射回查（碰撞 404）+ 3 回归锁 |
| 首号语义未落实（每号皆写） | 严重 | ✅ 首号判定写入 + boot 恢复 + 测试锁死 |
| DELETE 释放绑定缺失 | 严重 | ✅ releaseFeishuConnectionAndArchiveLine（微信同构）；cancellationReason 改预留注释（createOnly 流无复活面，检视 N2） |
| createOnly 未传 | 严重 | ✅ createOnly: true |
| 词表不合规 | 严重 | ✅ amend：实现 commit → mechanism-addition，处置 commit → narrow-fix |
| ①虚假✅ | 建议 | ✅ 本文档订正（同号提示/拒绝路径改📋 未实现） |
| ②死代码 | 建议 | ✅ startFeishuScanChannels 删除 |
| ③单源未达成 | 建议 | ✅ client.ts 入站锚改 deriveBotKey() |
| ④ownerOpenId 回填 | 建议 | ✅ processor p2p 入口回填（仅缺失时写） |
| ⑤门禁双缺席 | 建议 | ✅ owner 缺失退 config 锚；双缺席面记遗留（上节） |
| ⑥appId 出网 | 建议 | ✅ getLogin 回包掩码化 |
| N1 会话标题完整 appId | delta 新 | ✅ 缺省回退改 maskAppId |

## 不兼容更新

无。[Incompatible] 无标注项。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 每条 WS 独立装配 | D1 独立 tokenManager/Client | 共享单例多路复用 | 飞书 token 按 app 域隔离，共享无收益有串扰 |
| 二维码渲染 | D2 服务端 png base64 | 前端 qrcode.react | DTO 与微信全同，前端组件复制，零新依赖（qrcode 包已在依赖） |
| 重复扫码 | D3 每次建新 app（+同号提示） | 绑定旧 app 更新 | SDK 注释明示绑定覆盖 webhook 的风险；冗余可删；onSuccess 前同号检测给「已有助理线 X」确认框（微信 lookupExistingAccount 同构） |
| 凭据存储 | D4 文件（accounts 同构） | connections 表加列 | 密钥不入 DB（暴露面），DB 无消费方 |
| 存量模式 | D5 并行保留（出站键控化含静态 app） | 强制迁移扫码 | 存量零风险；键控改造行为等价 |
| 助理线开通时机 | 幂等 provision 独立端点，onSuccess 自动触发一次 | onSuccess 全捆绑 | 拆端点可重试、失败不阻建 app；微信先例同构 |
| 建线键 | D6 botKey 统一派生（掩码形态） | 原始 appId 直接拼 | 与入站路由锚同源，杜绝键分裂（F20260921wxba） |
| 搭档语义 | D7 首号先写先得全局锚 + 其余线 owner | 全局多号皆搭档 / 每线各自搭档 | 多号皆搭档 = #1188 错认债重演；每线语义引入 resolver 生命周期摇摆且当前无多家庭需求 |

### 审视处置记录（round 1，方案检视獭 mimo-pro）

| 发现 | 级别 | 处置 |
|---|---|---|
| 建线键与路由锚不一致（掩码 vs 原始 appId） | 严重 | ✅ D6：bot-key.ts 统一派生，三处同源 |
| 出站路由未设计（单通道无 per-app 归属） | 严重 | ✅ 键控出站（#591 同构）+ FeishuMessageChannel 按 botKey 过滤 |
| 身份模型三处矛盾 + resolver 运行时不更新 | 严重 | ✅ D7：首号先写先得 + addPartnerId 可变方法；每线语义记遗留；ownerOpenId 缺失首消息回填 |
| 未决 1 灰度措辞 + 实测清单不足 | 建议 | ✅ 实测三清单（p2p/群@/事件到 WS）+ 兜底改控制台手调；删「不依赖灰度」 |
| 状态机 5 态 vs 前端七态矛盾 | 建议 | ✅ 显式声明无 scanned 态，前端按实际映射 |
| 重复扫码无同号收敛 | 建议 | 📋 未实现（代码审视轮订正）：同号提示与拒绝路径未落地——重复扫码建新 app 属预期，删除入口兑底；低频场景留后续（顺手项不阻合入） |
| 运行时注册表 + 状态投影多实例 | 建议 | ✅ feishuRuntimes Map + channel-status 多实例化入模块清单 |
| qrcode 包已存在 | 建议 | ✅ 文档订正（已在依赖） |
| onSuccess 事务捆绑 | 建议 | ✅ 幂等 provision 端点拆分 |
| maskAppId 碰撞面（观察项） | 观察 | 键派生模块内注记 |

### 审视处置记录（delta 轮，方案检视獭）

| 发现 | 级别 | 处置 |
|---|---|---|
| D7 门禁锚定源未钉死（(c) 字面实现 = 纯扫码门禁全开） | 必修 | ✅ D7 改双层锚：称谓全局首号 + 命令门禁每线 `new PartnerResolver(线owner, 首号owner?)` 双锚（排除 (c)）；第二扫码人命令预期写入手测清单 |
| A 出站 key 双重前缀 | 建议 | ✅ 直接用 botKey 做键（channel-status 同源） |
| B 同号拒绝路径孤儿 app | 建议 | 📋 未实现（代码审视轮订正，同上条）：拒绝路径随同号提示一并留后续；孤儿 app 可在飞书开放平台手动删 |
| C 工厂提参范围仍欠准 | 建议 | ✅ 修正为吸收 createFeishuBundle(:310-328)+setupFeishu(:341-414) 两段 |
| D 手测缺第二扫码人 | 建议 | ✅ 补场景与预期（称呼链/标签/门禁三断言） |

省事声明审计：本方案「对齐微信模式复制组件」类表述——省掉的是前端交互设计与状态机设计的从零成本，代价由「微信/飞书组件相似但不共享」承担（两份代码各自演化），主人明确（本项目 IM 页已接受 QRCodeLoginCard 单例形态，复制是既定模式而非新债）。

## 验证

- 单测：login-session-manager 状态机（start/get/cancel/过期，无 scanned 态）+ app-store CRUD + controller 端点（safeJsonBody 防御 + 幂等 provision）+ buildFeishuRuntime 工厂装配（mock WSClient）+ **bot-key 派生一致性（provision 键 === 入站路由键）** + **多 app 出站隔离（A app 消息不进 B app 通道）** + addPartnerId 幂等/先写先得
- 集成：扫码 onSuccess 全链（mock registerApp）→ store 落库 → resolver 写锚 → runtime 注册 → 出站定向
- 实测三清单（真机）：p2p 收发 / 群 @ 收发 / 事件到达 WS
- 存量回归：config.yaml 静态 app 路径测试全绿（装配重构+键控出站行为等价）
- 手测清单：真机扫码 → p2p 对话 → 海獭回复带 [搭档(称呼)]（首号锚生效）→ 删除账号 → WS 停止+出站通道注销；**第二扫码人场景（delta D）**：joy 扫码建自己线 → 称呼链出 [joy]（线 owner metadata 生效）→ 标签显 `joy`（快照名，非「搭档(joy)」形态——D7 称谓遗留；注：resolveUserEntryLabel 访客分支只出快照名/裸 ID，「访客」字样仅在会话注入文本）→ 命令门禁：joy 在自己线可跑命令（每线 owner 锚），陌生人被拦（「这些命令暂时不对所有人开放哦」）——防实现期误「修」或误判 bug

### 实现落盘记录（2026-09-28）

- 后端：bot-key.ts / app-store.ts / login-session-manager.ts / feishu-connection-controller.ts 新建；bootstrap/feishu-scan.ts 装配抽出（app.ts 行数闸）；platforms.ts 工厂化（buildFeishuRuntime + finishFeishuRuntime + buildScanFeishuProcessor）；FeishuMessageChannel 构造改对象参数 + ownsConnection 四处归属判定；PartnerResolver configured 改 getter + addPartnerId；FeishuLongConnectionClient 构造加 channelId 第五参；router/controllers 接线（/api/feishu/* 六端点）
- 前端：FeishuQRCodeLoginCard（微信同构，无 scanned 态）+ IM 页飞书卡三态流（idle/naming/connecting）+ 账号列表（掩码 appId + 删除）+ client.ts DTO/API
- 验证：后端 tsc 0 错 / eslint 0 错 / 全量 291 文件 4091 测试过；前端 tsc 0 错 / vite build ✓（3346 modules）
- 待真机：实测三清单 + 手测清单（部署重启后验证）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/feishu/bot-key.ts | 新增 | 统一键派生（掩码 botKey） |
| src/frameworks/feishu/app-store.ts | 新增 | 凭据落盘 |
| src/frameworks/feishu/login-session-manager.ts | 新增 | registerApp 包装+状态机 |
| src/interface-adapters/http/controllers/feishu-connection-controller.ts | 新增 | 登录/账号管理/幂等 provision 端点 |
| src/usecases/im/feishu-message-channel.ts | 修改 | 键控出站（botKey 归属过滤） |
| src/usecases/im/partner-resolver.ts | 修改 | addPartnerId 可变方法 |
| src/usecases/im/message-broadcaster.ts | 修改（若需） | 出站通道 key 键控化配套 |
| src/bootstrap/platforms.ts | 修改 | setupFeishu 提工厂 + 键控出站 + startFeishuScanChannels |
| src/bootstrap/controllers.ts | 修改 | 注册新 controller |
| src/app.ts | 修改 | 运行时注册表 + 扫码通道启动/dispose + provision 闭包 |
| src/interface-adapters/http/controllers/channel-controller.ts | 修改 | 状态多实例投影 |
| web/src/components/feishu/FeishuQRCodeLoginCard.tsx | 新增 | 扫码组件（微信同构，状态枚举差异） |
| web/src/pages/im/index.tsx | 修改 | 飞书卡扫码入口+账号列表+多实例状态 |
| web/src/api/client.ts | 修改 | DTO + API 函数 |
| docs/features/2026/09/29/F20260929fsqr-feishu-qr-onboarding.md | 本文档 | 含 round 1 审视处置记录 |

（package.json 无改动——qrcode 已在依赖）
