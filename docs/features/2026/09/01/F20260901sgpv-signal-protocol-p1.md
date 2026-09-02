---
id: F20260901sgpv
title: '协作机制 v2：信号协议 P1 — 信号路由器（入口换轨）'
summary: '信号协议（F20260901sgpx）实现第二阶段：新建 SignalRouter 作为调度收敛点，web 主入口与 IM 入口（飞书/微信）换轨至信号路由（投递即点火 + busyQueue 排队 + 档位矩阵 P1 落地面），resume 启动补扫接入信号补路由（崩溃窗口兜底），消费失败 healing 可见。P1 边界内 scheduler/web-retry 暂留直连链，链引擎本体不动。'
change_type: feature
status: draft
capability_test: "n/a: P1 为调度骨架换轨（A 类行为契约测试覆盖，见## 验证）；能力级验证（插话不打断/锁超时消失）在 P2 invoke 循环落地后以 capability 测试覆盖"
tags: [agent-architecture, signal-protocol, dispatch, collaboration]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
---

# F20260901sgpv: 信号协议 P1 — 信号路由器

## 背景

信号协议母方案见 [F20260901sgpx](https://github.com/chenlaicai/otter-buddy/pull/669)。P0（F20260901sgp0，PR #678）已铺轨信号元数据（messages 表 signal_level/signal_meta 列 + yield level 参数）。P1 的任务（母方案迁移路径）：**信号路由器：invoke 内按档位选通道（触发/steer/abort）；四入口改投信号**。

施工输入：flash 四入口勘测（对话工作区 p1-entry-audit.md，行号锚定 main @ 03cc903e）+ 母方案「迁移施工输入」六项硬约束。

## 变更说明

### 1. SignalRouter（src/usecases/conversation/signal-router.ts，新建）

调度收敛点。核心机制：

- **收件箱 = 游标视图**（母方案 §1「存储」的直接落地）：未消费信号 = 目标獭未读视图（getUnreadMessages）内、指向该獭的 completed 消息。消费 = 链内 markBatchRead 推进游标（既有机制）——路由器读游标判别、不写游标（读路径判别/写路径消费，职责分层）
- **目标发现**：最近 SCAN_LIMIT(200) 条 completed 消息中非 system、非 user-only、非自指的 talkingStonePassedTo 去重集
- **P1 档位矩阵**（母方案 §1 三档的 P1 落地面，steer/abort 物理通道归 P3）：
  - NORMAL：idle 点火 / busy 入 busyQueue
  - URGENT：同 NORMAL（busy 直注入 steer 归 P3）
  - HALT：投往小獭 → 丢弃 + healing 留痕（C2 权限的绕过防线，P0 拦 yield 层、P1 拦路由层）；投往大獭 → busyQueue 队首优先消化
- **busyQueue（内存）**：busy 目标的待消化信号，入队时快照 segments 内容。Why 必须保内容：busy 獭的链结束时 markBatchRead 推进游标会把同 turn 内中途到达的消息「消费但未注入」，只靠未读视图重扫拿不回内容；显式快照注入与现状第二条链的传参语义对齐——**插话语义从「锁超时报错」升级为「排队必达」**（P1 验收标准）
- **同 otter 串行**：inFlight 集合 + isOtterActive（最新 streaming 消息 5min 内）双判定；invoke 完成后 50ms 去抖重扫（先 drain busyQueue 再扫未读——母方案 §2「完成时检查」的竞态兜底）
- **消费失败可见**（七刀之七）：链异常 → healing 落账（errorType=other，severity=high），替代现状 allSettled 静默吞错
- **点火动作**：DispatchChainEngine.executeChain（空 userMessageContent——链内 buildMessageWithContext 注入完整未读；busyQueue 消化路径传快照内容），fire-and-forget 不阻塞入口

### 2. 入口换轨（三入口）

| 入口 | 变更 | 降级面 |
|---|---|---|
| web sendMessage | MC.streamDispatchResponse：无注入载荷时走 routePendingSignals（火车头换轨） | signalRouter 未注入或带多模态注入 → 直连链（原路径） |
| IM 飞书 | ADS.dispatch：无注入载荷时走 routePendingSignals；**resolveFirstTurnTargets 隐式查询在路由路径下不可达**（四入口硬约束 1：删而不双轨——旧查询仅保留在降级路径，随 P2 退役） | 同上 |
| IM 微信 | 与飞书同构（startWeixinAccount 装配透传 signalRouter） | 同上 |
| resume | RIS.resume()：启动时 routeAllPending()（全会话信号补扫，崩溃窗口兜底——写路径没能点火的信号在此补路由） | signalRouter 未注入 → 不补扫 |

### 3. DI 装配（app.ts / platforms.ts / controllers.ts）

- app.ts：agentInvoker 诞生后 new SignalRouter（闭包捕获 agentInvoker.invokeConversation），注入 MC（controllers.ts deps）/ ADS（platforms.ts setupFeishu + startWeixinChannels 两处）/ RIS（app.ts）
- 全部可选注入：未注入时三入口走原直连链路径（灰度回滚面——出问题改装配即回滚，不动业务代码）

## 不在范围内（P1 边界）

- **scheduler 入口不改**：定时任务信号是 system 发送者，路由器显式排除 system——scheduler 直连链与信号路由并存会造成同一任务双重执行（双真相源竞态）；scheduler 入口化与看门狗语义迁移（七刀之三）在 P1 后续 PR 单独落地
- **web retry 不改**：需要 manualRetry/images 参数透传设计，与 scheduler 同批
- **invoke 循环不替代链引擎**（P2 灰度战场）：路由动作仍由 executeChain 承载，链深度上限/链内 aggregatedTargets 消费全部保留
- **多模态消息走直连链**：图片/文档注入载荷只存在请求内存中，信号路由从消息表重建内容拿不到——多模态×信号路由的统一归 P2 接缝层
- **URGENT steer 直注入 / HALT abort 物理停**（P3 打断决策协议）
- **写路径 emitter 中间件**：本 PR 未引入（入口显式驱动路由已覆盖 P1 场景；emitter 作为 P2「投递即点火」的完整形态落地，避免本 PR 引入自动点火与入口显式调用的竞态双轨）

## 验证

### 单测（tests/usecases/conversation/signal-router.test.ts，9 用例）

- 未读信号 → 点火链引擎且目标正确
- 无未读（已消费）→ 空路由（幂等：游标即消费账本）
- 目标 busy（外部 streaming）→ queued_busy 不点火（内容保全入队）
- HALT 投往小獭 → skipped + healing 留痕（permission_denied）
- 链抛错 → healing 留痕（消费失败可见性）
- 目标已解散 → skipped_inactive
- self-yield → 不点火（防自链病态在路由层获得驱动）
- system 信号 → 路由器不接管（P1 边界）
- routeAllPending 全会话扫描

### 全量

- 209 test files / 2606 tests 全部通过；tsc 干净；eslint 0 error（5 warnings 为 pre-existing web 文件）

### 回归面（换轨入口的既有行为）

- MC/ADS/RIS 全部为可选注入降级设计：不注入 signalRouter 时行为与 main 完全一致
- 换轨路径的行为差异集中在调度层（先查未读再点火 vs 直连首跳 invoke）：链内 buildMessageWithContext 未读注入机制不变，正常消息（completed、无附件）的 LLM 可见内容等价

### 最简实现检查

已过最简检查：无新表、无新列、无新依赖；路由器单文件 + 三入口可选注入（~300 行核心 + 装配），消费/游标/名册/注入全部复用链引擎既有机制，路由器只做「判别 + 排队 + 点火 + 留痕」。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 消费判据 | 未读游标视图（读既有 getUnreadMessages） | signal_level 非空 + 独立已消费标记 | 母方案「收件箱 = 游标视图」的直接实现；独立标记引入第二真相源（游标与标记漂移即重复消费/漏消费）；markBatchRead 是现成的消费写入点 |
| busy 内容保全 | 内存 busyQueue + segments 快照 | 只留信号等游标重扫 | 同 turn 中途到达的消息会被 markBatchRead「消费但未注入」（游标推进吞内容）——插话主场景必须保内容 |
| scheduler/retry 不换轨 | 本 PR 排除（system 信号路由器不接管） | 一并换轨 | system 信号入路由 + scheduler 直连并存 = 同一任务双重执行；且看门狗语义迁移（七刀之三）需要独立设计，混入本 PR 会把「调度骨架」和「看门狗」两个手术面搅在一起 |
| 多模态走直连 | !injection 条件分流 | 全量换轨 + 注入载荷持久化 | 载荷持久化是 P2 接缝层的活；本 PR 用最小条件分流保行为零回归 |
| 点火 content | 空 userMessageContent（靠链内未读注入） | 信号内容显式传参 | 链的 buildMessageWithContext 本就把未读注入「当前任务」段——显式传参会双重注入；busyQueue 消化路径例外（游标已推进，必须传快照） |
| HALT 到 busy 大獭 | 入 busyQueue 队首（下次消化优先） | 立即 abort | abort+clearQueue 语义链路属 P3 打断决策；P1 抢跑会把「停机请求送达」和「物理执行停止」做成两个半吊子 |

## 迁移路径

- P0（已合入 #678）：信号元数据铺轨
- **P1（本 PR）**：信号路由器骨架 + web/IM 入口换轨 + resume 补扫
- P1 后续：scheduler 入口化（看门狗语义迁移）+ web retry 参数透传 + 写路径 emitter
- P2：invoke 循环替代链引擎 hop 驱动（灰度开关）+ SSE 关闭条件重定义 + 多模态×信号路由接缝
- P3：打断决策协议（URGENT steer / HALT abort / yield-to-self / 梯度护栏）
- P4：turn 退役（UI 派生视图已先行，#677）
