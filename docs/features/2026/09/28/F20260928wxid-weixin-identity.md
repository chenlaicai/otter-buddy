---
id: F20260928wxid
title: 微信身份链补齐：扫码自报称呼（metadata.userName→senderName）+ IM 页状态映射修复 + 跨渠道搭档判定
summary: 搭档微信实测两个问题。①IM 页状态「未知」——#1055 重写 IM 页时状态映射被错写成 ok/degraded/error_backoff 三态（后端从无 ok/degraded），running/token_stale/stopped/starting 全落 default「● 未知」；且微信聚合 hasStale 找 kind='degraded'（不存在的值）→ token_stale 永远漏报。恢复 #655 五态完整映射。②微信上问「我是谁」，海獭答「飞书账号（加密 ID）」——三层根因：(a) 微信协议无查用户资料 API（api-client 仅轮询/发消息三项，飞书有 getUserName 而微信无对应物）；(b) 微信消息入库 senderName 恒空（生产库实锤：12 条消息 sender_name 全空）；(c) dispatch-chain-engine 给海獭的注入文本硬编码「访客，飞书 open_id」，微信消息也这么标 → 海獭在信息不足下脑补成飞书账号。修复：扫码建线流程增可选「你的称呼」输入（存 connection.metadata.userName，微信靠自报是协议限制下的唯一解，与飞书 API 查名等价），入站消息读 metadata 填 senderDisplayName 快照；注入文本按 senderId 形态（@im.wechat 后缀）标注渠道；PartnerResolver 构造器改 rest 收多渠道 ID（dispatch-chain-engine 装配处传双渠道——微信入站后海獭也能认出「是搭档本人」；两处命令门禁装配保持单渠道锚防 configured 误翻锁死命令）；存量线补 PATCH /accounts/:id/user-name 端点 + IM 页账号卡「设置称呼」入口。
doc_type: feature
change_type: fix
capability_test: "n/a: IM 通道身份链/状态展示变更，无 prompt 行为语义可测（回归用例：tests/usecases/im/partner-resolver.test.ts F20260928wxid 四例 + tests/interface-adapters/weixin/message-processor.test.ts 称呼链三例）"
created_in_conversation: 8c447618-ef7a-4b21-8b01-45c6ebff138b
tags: [weixin, im, assistant, identity, senderName, status-mapping, bugfix]
modules:
  - src/usecases/im/partner-resolver.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/interface-adapters/weixin/message-processor.ts
  - src/interface-adapters/http/controllers/weixin-connection-controller.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/controllers.ts
  - src/app.ts
  - web/src/pages/im/index.tsx
  - web/src/api/client.ts
  - tests/usecases/im/partner-resolver.test.ts
  - tests/interface-adapters/weixin/message-processor.test.ts
causal_links:
  - F20260921imux
  - F20260922wxeg
  - F20260901chun
  - F20260826fpbd
  - F20260826fuid
created_at: 2026-09-28
---

# 微信身份链补齐 + IM 状态映射修复

## 预注册（动手前冻结）

- 预期根因方向：P1 状态「未知」= 前端 kind 映射与后端状态机错位（后端五态 vs 前端三态，枚举值对不上）；P2 海獭说飞书 = 微信侧 senderName 全空 + 注入文本渠道误导，海獭在信息不足下的脑补
- 验证标准：P1 找到前后端 kind 枚举错位的 file:line + git 归因（哪次改动打断）；P2 生产库微信消息 sender_name 为空实锤 + 找到海獭注入文本里渠道误导的 file:line
- 若证据指向「后端真发了未知状态」或「消息被误路由进飞书链路」则放弃原预期

实际：预期命中。P1 前端 web/src/pages/im/index.tsx getStatusLabel/getStatusColor 只认 ok/degraded/error_backoff（后端五态为 starting/running/token_stale/error_backoff/stopped，无 ok/degraded）；git 归因 #655 原始版为完整五态映射，#1055 重写时打断。P2 生产库（data/otter-buddy.db）12 条微信 user 消息 sender_name 全空；dispatch-chain-engine.ts 注入文本硬编码「访客，飞书 open_id」。

## 问题现象

搭档 9/25-9/28 微信实测：

1. **IM 页微信通道状态显示「● 未知」**（通道实际运行正常）
2. **微信上问海獭「我是谁」，答「我看到的是一个飞书账号（我只拿得到一串加密 ID）」**——明明是微信消息，海獭却说是飞书

## 根因分析

### P1 状态「未知」= 前端映射断裂

- 后端状态机五态：`src/usecases/channel/channel-status.ts`（starting / running / token_stale / error_backoff / stopped；running 可带 degraded 标志）
- 前端 #1055 重写后只认 `ok` / `degraded` / `error_backoff`——**后端从来没有 ok 和 degraded 这两个 kind** → running（正常！）/ token_stale / stopped / starting 全落 default 分支显示「● 未知」
- 连带 bug：微信聚合状态 `getWeixinAggregateStatus` 的 hasStale 找 `kind === 'degraded'`（不存在的值）→ **token_stale（最需要用户知道的「该重新扫码了」）在聚合视图永远漏报**
- git 归因：#655（9/1 IM 通道统一）原始版五态映射完整；#1055（9/20 IM 助理模式修订二）重写时错写

### P2 海獭说「飞书账号」= 微信身份信息全链缺失 + 注入文本渠道误导

三层根因（协同作案）：

1. **协议层**：微信 ilink 协议无查用户资料 API（api-client.ts 仅 pollQrStatus / sendTextMessage / sendMessageItems 三项）。飞书有 getUserName（F20260826fuid「id 找飞书名称」），微信侧从未有对应物
2. **存储层**：微信消息入库 senderName 恒空（message-processor 不传 senderDisplayName；生产库实锤：12 条微信 user 消息 sender_name 全空）→ 海獭看到的是裸加密 ID `[o9cq…@im.wechat] 我是谁`
3. **注入层**：dispatch-chain-engine 构建在场成员段时硬编码「非你的搭档（访客，飞书 open_id: ${senderId}）」——微信消息也这么标 → 海獭拿到「陌生加密 ID + 飞书字样」在信息不足下脑补成「飞书账号」

另外：搭档本人（chen）的微信消息也没被认出——PartnerResolver 只认飞书 open_id，配置里的 weixin.partnerUserId（`o9cq…@im.wechat`）只用于命令门禁，不用于身份标注。

## 修法

### P1 状态映射恢复

- getStatusLabel/getStatusColor 恢复五态完整映射（照 #655 原始版语义 + degraded 附属标志）
- getWeixinAggregateStatus 的 hasStale 改找 `token_stale`

### P2 身份链（三层各自的解）

| 层 | 修法 | 对应飞书机制 |
|---|---|---|
| 协议层无查名 API | **扫码建线时自报称呼**（用户提议）：「先名后码」流程第 1 步增可选「你的称呼」输入，存 connection.metadata.userName | getUserName API（微信靠自报，等价解） |
| 存储层 senderName 空 | message-processor 入站时读 metadata.userName → sendUserEntry senderDisplayName 快照（有则传，无则维持现状） | 飞书 resolveAssistantName 同构 |
| 注入层渠道误导 | dispatch-chain-engine 按 senderId 形态标注渠道（含 `@im.wechat` → 微信，否则飞书） | — |
| 搭档本人认不出 | PartnerResolver 构造器改 rest 参数收多渠道 ID；dispatch-chain-engine 装配处传 (feishu.partnerOpenId, weixin.partnerUserId) | — |

### 门禁语义保护（防回归）

PartnerResolver 两处**命令门禁**装配（platforms.ts setupFeishu / setupWeixin processor）**保持单渠道锚**：门禁语义是「配置了本渠道搭档锚才拦截」，若混入另一渠道 ID，只配微信的场景 configured 会误翻 true → 飞书命令被全量锁死。跨渠道身份标注只走 dispatch-chain-engine 装配处（那里 configured 只影响展示不影响门禁放行）。

### 存量线兜底

新线扫码时填称呼；存量线（如已建的助理线）补 PATCH /api/weixin/accounts/:id/user-name 端点 + IM 页账号卡「设置称呼」入口（prompt 弹窗，空串=清除）。

## 设计取舍

### 机制识别检查点命中与 narrow-fix 论证（F20260928wxid 补录，检视发现 3 处置）

检查点命中项：□新增决策分支（PATCH user-name 端点写 metadata.userName 分支）☑命中；□新增跨模块调用路径（controller→connectionRepo.mergeMetadata）☑命中。

为何命中但不涉净新增机制：两项均复用既有机制不动其管辖边界——(a) connection.metadata 是既有自由键值存储（F20260922wxeg 已存 lastChatId，同模式读写，未新增表/字段/生命周期，仅新增一个约定键 userName）；(b) PATCH 端点复用既有 weixin-connection-controller 的路由注册/参数校验/mergeMetadata 通道，与 feishu partnerOpenId 管理端点同构，无新进程/新信号类型/新配置开关。判定：修法决策树①（narrow-fix，既有机制语义内补链，非机制新增）。

### 其他取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 微信无查名 API 的替代 | 扫码自报称呼存 metadata | 从消息协议拓字段/第三方库 | 协议无此能力；自报与飞书 getUserName 等价解（搭档提议） |
| PartnerResolver 多渠道 | rest 构造器 + 门禁单渠道锚 | forGate/forIdentity 拆双类 | 本轮最小改动；拆类留后续（检视建议 4 已记 issue 待建） |

## 影响范围与风险

- 飞书侧零改动（PartnerResolver 多参构造向后兼容，旧调用处行为不变）
- 称呼解析失败（getConnection 抛错）降级裸 ID，不阻断主链（有测试）
- provision 时 metadata 写失败仅 warn 不阻断建线
- 已知遗留（本轮不修）：weixin partnerUserId 未配置且有多账号时，app.ts 兜底取首个账号 ilinkUserId 当搭档——多账号场景「第一个扫码的人」会被错认成搭档（单账号无碍，记入后续）

## 验证

- 后端 tsc 0 错；全量 vitest 4011 过（285 文件，delta 后）
- 新增回归：partner-resolver.test.ts F20260928wxid 四例（双渠道匹配/单参兼容/空白过滤/trim 容错）；message-processor.test.ts 称呼链四例（有称呼快照/无称呼目标分支/访客不盖 owner 称呼/解析失败降级）；dispatch-chain-engine.test.ts 三例（搭档带快照 [搭档(joy)]/访客快照不冒充/触发消息带标签一问一答可见）
- 前端 tsc 0 错；vite build ✓（3345 modules）
- 对抗审视：检视獭（mimo-pro）round 1 + delta 复核 6/7 → PR body 补 Modification-Class 落点 + 触发消息标签（检视建议 2 真交付）+ 测试漂移修正（建议 3）+ 注释归源还原（建议 1）；parseUserName sanitize 与 PartnerResolver 拆类记遗留
