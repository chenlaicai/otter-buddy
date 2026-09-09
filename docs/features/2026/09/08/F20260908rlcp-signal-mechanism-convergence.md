---
id: F20260908rlcp
title: 信号机制收敛与 session 热池：followUp/steer/abort 三动作统一 + 台账/busyQueue/闸门退役 + 429 整改
doc_type: feature

summary: |
  搭档 09-08 八轮过堂收敛的终态信号模型。底层：LRU 热池（session 对象活的常驻、
  冷的驱逐，容量默认 50 可配 + TTL 30min），SDK followUp 原生接管忙时排队，
  per-otter 锁与事件 B 退役。上层：档位概念（NORMAL/URGENT/HALT）全系统移除，
  统一为三动作——followUp（默认）/ steer（调用方标急）/ abort（session 方法调用，
  非消息非信号）。游标唯一推进点 = prompt 启动成功，推进到启动时读到的位置
  （运行期新到消息恒保持未读）。dispatch_attempts 台账、busyQueue、双闸门、阻尼、
  墙钟窗、markBatchRead、50ms 重扫、GateBanner、signal-trail 全部退役——皆为
  旧游标语义或重燃 bug 的补丁层。steer 崩溃安全走恢复侧 jsonl 尾部去重（出路 A）。
  429 整改同修：无冻结、快速失败、诚实告知、exhausted 分类修复。

causal_links:
  from:
    - F20260901sgpx   # 母方案目标态（搭档 9/1 04:44 四段式模型原话）
    - F20260902sgp2   # 台账语义（本方案论证其为旧游标语义补丁并退役）
    - F20260903ihlt   # 闸门（双闸门均退役）
    - F20260903damp   # 阻尼（退役）
  supersedes:
    - F20260902sgp2   # 台账语义被游标新语义取代
    - F20260903ihlt   # 闸门整体退役

status: draft
change_type: refactor
tags: [signal-protocol, architecture-convergence, cursor-semantics, session-pool, rate-limit, tech-debt]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/session-pool.ts
  - src/usecases/conversation/signal-router.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/usecases/conversation/agent-turn-orchestrator/rate-limit-error.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/frameworks/db/conversation/
  - src/frameworks/db/schema.ts
created_in_conversation: c97f3b93-1ef8-419f-8997-b64ac33be16e
capability_test: "双獭会话全链路：①忙獭收 3 条信号→followUp 排队→停手后 SDK 自动消化；②glm 撞 429→快速 failed+诚实告知，kimi 獭不受影响；③崩溃恢复后 steer 已消化消息不重复注入"
intent:
  problem: "信号机制补丁堆叠（台账/busyQueue/闸门/阻尼皆为旧游标语义补丁），整体复杂度失控；429 会话级冻结误伤多模型会话"
  expected_effect: "机制数量净减 11 项；忙时排队由 SDK followUp 原生承载；429 不再冻结任何信号；exhausted 正确分级"
  verify_by:
    type: behavior_check
---

# F20260908rlcp: 信号机制收敛与 session 热池

## 背景

搭档 09-08 八轮过堂原话链（意图锚）：

1. 「熔断本对话所有信号是个bug！……你应该去拆弹，而不是把这个炸弹包了一层又一层的铁皮」
2. 「移除这个冻结，因为这个配额有时候我可能会使用重置或者其他手段，本系统侧不应该做强制冻结」
3. 「busyQueue和游标就是同一件事的两份机制了呀，都是表示"未读"信息呀！」
4. 「台账为什么收紧而不是移除？」
5. 「我要你完整分析思考整套信号系统……破而后立！」
6. 「已读/未读跟点火/信号/invoke/行动权是分开的，不存在"未读区有tsp"这种说法」
7. 「容量作为可配置的，默认50个」（LRU 热池拍板）
8. 「全系统移除urgent/normal哦，现在就是用steer和followup」

历史锚：母方案《协作机制 v2：信号协议》（F20260901sgpx）+ 搭档 9/1 04:44 四段式
invoke 模型原话。

### 偏差因果链（一条偏差催生五层补丁）

```
游标「完成才移动」（与 9/1 目标态的偏差）
  └─ 忙时新信号会因 invoke 结束时游标推进而被覆盖已读 → 内容丢失
      └─ busyQueue 内容快照（补丁 1）
          └─ 队列+重扫竞态 → 09-03 同信号重燃事故（614 次/42s）
              └─ 60s 阻尼（补丁 2）+ 点火即记账（补丁 3）
              └─ 中断/429 期间重扫继续点火 → 用户停机闸门 + 限流熔断（补丁 4、5）
  └─ 游标滞后不可信 → 「未读≠待行动」→ dispatch_attempts 台账独立记账（补丁 0，表级）
```

台账与 busyQueue 是同一枚补丁的两侧：一个保行动义务、一个保内容——
而这两者都是游标本职。游标语义修正后滞留在结构上不可能（已读集合 ≡ 已注入集合），
台账防的两起事故（R1 崩溃误点 / R2 存量滞后）从根上消失。

## 目标

- T1 LRU 热池：session 对象活的常驻（容量默认 50 可配 + 空闲 TTL 默认 30min），
  SDK followUp 原生接管忙时排队；per-otter 锁退役（运行期单对象天然串行）
- T2 档位概念全系统移除：NORMAL/URGENT/HALT → followUp（默认）/ steer（标急）/
  abort（session.abort() 方法调用，非消息非信号）
- T3 游标新语义：prompt 启动成功即推进，推进到启动时读到的位置
  （运行期新到消息恒保持未读）；markBatchRead 删除
- T4 退役清单：dispatch_attempts 台账、busyQueue、双闸门、60s 阻尼、
  isOtterActive 墙钟窗、50ms 重扫、事件 B、GateBanner、/signal-trail 端点、
  steer 销账
- T5 steer 崩溃安全（出路 A）：恢复后首次 invoke 前读 jsonl 分支尾部，
  匹配 steer 包装中的原始 msg id，已消化的从未读注入剔除；运行期零监听
- T6 429 整改：无冻结（系统侧不做强制熔断），快速 failed + 即时诚实告知；
  exhausted 分类器补智谱「使用上限」文案；告警分态（transient/exhausted）
- T7 退役消费方迁移：SSE 关流改判消息状态机、看门狗判活改判消息终态、
  收件箱预告改未读计数

## 非目标

- URGENT 树化（navigateTree 分支处理 + 总结切回 + 展示映射）——下一版，
  热池是其地基；本轮 steer 轻量版保留
- 自动化改派 / fallback 模型链 / 配额探测（先鲁棒后自动化）
- SDK 重试层（maxRetries=4 维持）
- turn 展示层

## 方案设计

### 概念表（统一后，全系统唯一口径）

| 概念 | 定义 |
|------|------|
| 信号 | 消息落库 tsp=[X] 这个事件本身（无 pending 概念、无档位字段） |
| followUp | 默认动作。闲时=直接 invoke；忙时=session.followUp() 入 SDK 队列 |
| steer | 调用方显式标「急」。忙时 session.steer() 入 steering 队列，下一思考点注入 |
| abort | 不是消息不是信号——系统调 session.abort() 方法，当前 invoke 以 aborted 终态结束 |
| 游标 | participants.last_read_seq——上下文注入进度账，与点火/行动权完全无关 |
| 热池 | LRU 驻留的活跃 session 对象集，容量/TTL 可配 |

### 完整流程图（终态，六轮修正合入）

```
═══════════ 底层：LRU 热池 ═══════════

  信号到獭 X：X 在池→直接用活对象；不在→冷启动 restore 入池（jsonl 无缝恢复）
  invoke 完成→对象留池不 dispose
  驱逐：LRU + 容量上限（默认 50）+ 空闲 TTL（默认 30min）
  dispose=纯内存释放，历史已持久

═══════════ 触发事件（两个） ═══════════

 事件A：消息落库 tsp=[X]
        ← 搭档发言 / 獭 yield / scheduler / retry 系统消息
 事件C：重启补扫 → 进程死亡中断的标 failed + 发 retry 系统消息（走事件A）
        → 恢复后首次 invoke 前做「steer 已消化去重」（出路 A）

（abort 不是事件，是随时可调用的动作）

═══════════ 主流程 ═══════════════════════════

                 事件 A / C 到达
                       ▼
        ╔══════════════════════════╗
        ║  X 在热池且运行中？         ║
        ╚══╦═════════════════╦═════╝
   空闲/不在池║               ║ 运行中
           ▼                 ▼
  ┌─────────────────┐  ┌─────────────────────────┐
  │ 不在池则冷启动     │  │ 默认：session.followUp()  │
  │ restore 入池      │  │ 獭停手后 SDK 自动消化      │
  │ 读游标→取未读      │  │                         │
  │ 拼入上下文        │  │ 调用方标「急」：           │
  └────────┬────────┘  │ session.steer()          │
           ▼           │ ★不动游标、不销账、        │
  ╔═════════════════╗  │  包装带原始 msg id         │
  ║ prompt 启动成功？ ║  │  下一思考点注入           │
  ╚══╦═══════════╦══╝  └─────────────────────────┘
     ║           ║
失败 ║           ║ 成功     abort（任何时刻，独立于流程）：
     ▼           ▼        ┌───────────────────────┐
 ┌─────────┐  ┌──────────────────────┐  │ 系统调 session.abort() │
 │游标不动   │  │ ★ 游标推进到「启动时    │  │ → 当前 invoke 以      │
 │消息保持   │  │   读到的最新 seq」     │  │   aborted 终态结束     │
 │未读      │  │ （唯一推进点；运行期    │  │ → 零调度侧影响         │
 │标 failed │  │  新到消息恒保持未读）   │  └───────────────────────┘
 │+系统告知 │  └─────────┬──────────┘
 └────┬────┘            ▼
      │        ┌──────────────────┐
      │        │ LLM 运行期          │
      │        │ 新到消息默认 followUp │
      │        │ 排队；标急的 steer   │
      │        └────────┬─────────┘
      │                 ▼
      │    ╔═══════════════════════════════╗
      │    ║ invoke 结局（三种终态同构）：    ║
      │    ║ completed：发言落库+新tsp=事件A ║
      │    ║ failed：标 failed+诚实告知       ║
      │    ║ aborted：标 aborted（被 abort） ║
      │    ╚═══════════════╦═══════════════╝
      │                    │
      ▼                    ▼
   对象留池 ◀───────── 对象留池
   followUp 队列有积压 SDK 自动接着消化
   （无事件 B、无锁、无周期重扫）
```

### 改动 1：LRU 热池（新文件 session-pool.ts + pi-session-factory 改造）

```typescript
interface SessionPoolConfig {
  maxSize: number;      // 默认 50，config.llm.sessionPoolSize 可配
  idleTtlMs: number;    // 默认 30min，config.llm.sessionPoolIdleTtlMinutes 可配
}
```

- 池条目：{ session, sessionKey, otterId, conversationId, lastActiveAt, messageId 绑定 }
- 准入：信号到达 → 池命中且未运行→直接复用；未命中→restore 入池；
  池满→LRU 驱逐最旧空闲条目（dispose）
- 驱逐守卫：运行中（isStreaming/队列非空）的条目不可驱逐；TTL 扫描每分钟一次
- **工具闭包刷新**：池复用时 conversationId/messageId 等上下文需重新绑定
  （现状 createSessionWithTools 按 invoke 绑定——热池后改为每次 prompt 前刷新
  toolContext 的关键字段；SDK extensions/hooks 支持运行期改）
- dispose 语义不变：jsonl 已持久，再唤醒 restore 无缝
- 崩溃：热池蒸发无数据损失，全部冷启动（与现状等价）

### 改动 2：信号路由收敛（signal-router.ts 大改）

- 删除：busyQueue/QueuedSignal/drainBusyQueue/signalContent/rebuildInjection
  （路由路径）/userHalted/markUserHalt/clearUserHalt/isRateLimited/RATE_LIMIT_BLOCK_*/
  shouldThrottle 调用/isOtterActive/getGateState/skipped_halted/skipped_rate_limited
- routePendingSignals → routeSignal（事件驱动，不再有「扫 pending」）：
  - 目标在池且运行中：默认 followUp(text 从消息构建)；标急 steer(text)
  - 目标空闲/不在池：走 invoke 路径（热池准入 → 构建上下文 → prompt）
  - dissolved/inactive 目标过滤保留（防幽灵点火）
- steer 包装格式：`【急讯 msg:<messageId>】来自 <sender>：<内容>`——
  msg id 是恢复去重的匹配锚
- HALT 权限约束退役（档位字段没了）；abort 权限由入口侧承载
  （中断按钮=前端/API 层；halt_otter 工具=大獭专用，走 halt-registry 既有通道）

### 改动 3：游标新语义（dispatch-chain-engine.ts + conversation-repository）

- invoke 启动路径：buildMessageWithContext 取未读 → 记录本批最新 seq →
  agent-invoker 内 prompt() 发出且 SDK 订阅建立（未同步抛错）→ 回调推进
  `updateLastReadSeq(conversationId, otterId, batchMaxSeq)` +
  `updateLastActiveTurnNumber`（活跃度随游标同点迁移——「开始干活」语义，
  闲置预警同向不受影响）
- 启动失败：不推进，消息保持未读，下轮自然重注入
- markBatchRead 整体删除
- 恢复侧去重（出路 A）：resume/重启后獭首次 invoke 构建未读注入前，
  `SessionManager.getBranch()` 读 jsonl 尾部 entry，匹配 steer 包装中的
  `msg:<id>`，命中的 msg id 从未读注入集合剔除
  （messages 表按 id 过滤；成本=恢复路径一次尾部读，低频）

### 改动 4：台账退役（全链路）

- 删除：dispatch_attempts 表（migration drop + 归档说明）、DispatchAttemptRepo
  实体与实现、recordStart/recordFinish 插桩（链引擎+路由器）、pendingClause、
  shouldThrottle、listPendingSignals、countPendingForTarget、allAnchorAttemptsSettled
- retry：显式重传语义保留（原消息内容作「当前任务」重传，游标不动）；
  retryViaRouterPath 的台账覆盖记账删除
- 迁移：存量 dispatch_attempts 表数据导出 data/archive/ 后 drop

### 改动 5：429 整改（rate-limit-error.ts + orchestrator.ts + message-controller.ts）

- 移除：限流熔断全部分支（G6 文案中 rate_limited 分支、DirectChainGatedError
  的 skipped_rate_limited 取值、scheduler 直投的对应分支）
- 分类器：QUOTA_EXHAUSTED_PATTERNS 增补
  `/(使用|用量)[^\n]{0,6}上限/`、`/(每周|每月)[^\n]{0,12}(上限|限额|重置)/`
- 告警文案分态：
  - transient：「{獭名} 的模型 {alias} 瞬时限流（SDK 重试耗尽），本轮发言已终止。
    短时后可重试，或改派其他模型的獭。」
  - exhausted：「{獭名} 的模型 {alias} 配额耗尽（429 终态），本轮发言已终止
    {resetHint}。该模型在配额恢复前无法执行任务——可改派其他模型的獭，
    或恢复配额（充值/重置）后手动重试。」
- healing 落账 + C3 高警入队不变

### 改动 6：退役消费方迁移

| 消费方 | 迁移后 |
|--------|--------|
| SSE 关流（K3） | 轮询本轮消息 status 终态（消息表已有）。语义退化声明：忙时 followUp 排队场景从「精确终态关」退化为「30s 超时兜底关」 |
| 看门狗判活（S4b） | 锚点消息下游产出消息终态 + 持续产出判定 |
| 收件箱预告（K2） | 未读消息中 tsp 含本獭的计数（getUnreadMessages 过滤） |
| 信号轨迹 | query-signal-trail.ts 删除；/signal-trail 端点删除；GateBanner 删除 |
| yield 工具 level 参数 | 移除（档位概念退役）；signal_level 列保留不读（存量兼容）或随迁移删除——实现时定 |

## 影响范围

- 信号调度全链路（路由器/链引擎/五入口/scheduler/retry/resume）
- session 生命周期（热池取代冷启动 dispose）
- 信号轨迹 UI 整体移除
- 429 用户体验（无冻结，快速失败+诚实告知）

## 风险与约束

| 风险 | 缓解 |
|------|------|
| 热池工具闭包 stale（conversationId/messageId 绑定） | prompt 前刷新 toolContext 关键字段；AT 覆盖跨会话复用场景 |
| 游标推进时机 bug 导致消息漏注入 | 启动失败不推进（保持未读）；「读→推进→确认启动」顺序化 |
| 429 期间多条新消息各自独立撞墙失败 | 设计意图显式声明：逐条快速失败 > 全会话冻结（09-03 kimi 连坐实证） |
| 恢复去重误判（msg id 匹配失败） | 宁可重复注入（獭可见「已处理」自行跳过）不漏；匹配锚用唯一 msg id 而非文本 |
| 退役面大 | 分段合入：P1=热池+信号收敛；P2=台账退役+429 整改（P2 可拆 429 先上） |
| followUp 队列无限积压 | SDK 队列在内存；獭长忙时信号堆积靠 followUpMode="all" 停手时一次消化；极端积压（>100）记日志告警 |

## 不兼容更新

- [Incompatible] dispatch_attempts 表删除
- [Incompatible] /signal-trail 端点与 GateBanner 组件删除
- [Incompatible] yield 工具 level 参数移除（NORMAL/URGENT/HALT 档位概念全系统退役）
- [Incompatible] 限流熔断与用户停机闸门行为移除
- [Incompatible] signal_level 列退役（存量数据保留不读或迁移删除）

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|------|------|---------|------|
| D1 | 游标推进时机 | prompt 启动成功即推进（到启动时读到的位置） | 完成才移动（现状） | 启动成功=上下文已交付的最早可靠点；运行期新到消息恒未读=崩溃安全 |
| D2 | 台账 | 整体退役 | 保留作审计面 | 七职责逐一被游标/消息状态机替代；它是旧游标语义补丁 |
| D3 | 忙时排队 | SDK followUp 原生承载 | 事件 B（锁释放查堆积） | 热池使 SDK 队列可用；自研事件 B 是重复造轮子 |
| D4 | 档位概念 | 全系统移除，统一 followUp/steer/abort | 保留 NORMAL/URGENT/HALT | 搭档 19:18 拍板；档位是旧分层思维的残留 |
| D5 | 用户停机闸门 | 退役，中断=纯 abort | 保留简化 | 中断=invoke 终态化，与 completed/failed 同构；9/3 病根是重燃（已修） |
| D6 | steer 崩溃安全 | 出路 A：恢复侧 jsonl 尾部去重 | 运行期监听 message_end / steer 不落盘 | 运行期零成本；恢复侧低频取证；不动 SDK |
| D7 | 热池驱逐 | LRU+容量+TTL 三因子 | 纯 LRU / 纯 TTL | 容量防爆内存（搭档关切）、TTL 收冷却会话、LRU 保活跃 |
| D8 | 防御层次收敛 | 显式声明：防重从多层收敛到单层（游标） | 保留内存阻尼 | 单一化前提=游标语义正确性由 AT-1/2/5 验收兜底 |

**机制预算四问**（净增机制两件：热池 + 启动成功回调）：
热池：① 谁需要——协作密集期的獭（连发信号不冷启动）+ 忙时排队语义（SDK followUp 前提）；
② 失败后果——驱逐误判=冷启动恢复（秒级，现状等价）；③ 后续机制——驱逐守卫/TTL 扫描
（均已含）；④ 退役条件——常驻化整体否决时回到冷启动（jsonl 持久化保证可回退）。
启动成功回调：① 每次 invoke 的獭；② 推进失败=下轮重注入（重复读无害）；
③ 无新状态；④ 游标机制整体被取代时。

**零基重推**：dispatch_attempts/busyQueue/闸门×2/阻尼/墙钟窗/markBatchRead/50ms 重扫/
事件 B/per-otter 锁/GateBanner/signal-trail/steer 销账/三档 level——逐项「从零设计还会加吗」
全部淘汰。带入清单：游标（seq）、tsp、steer/followUp/abort、热池、消息状态机、
per-otter 对象唯一性（热池天然）、恢复去重。

## 验证

| 编号 | 需求 | 预期 |
|------|------|------|
| AT-1 | 游标新语义 | 启动成功后游标=启动时读到的最新 seq；启动失败游标不动；运行期新到消息恒未读 |
| AT-2 | 崩溃窗口 | 推进后崩溃→重启不重复注入；推进前崩溃→消息未读正常注入 |
| AT-3 | followUp 排队 | 忙獭收 3 条默认信号→獭停手后 SDK 自动消化全部（无 busyQueue/事件 B） |
| AT-4 | steer | 忙獭收标急信号→下一思考点注入；游标不动不销账 |
| AT-5 | 无重燃 | 同信号处理后零重复点火（结构性防重，无台账无阻尼） |
| AT-6 | 429 无冻结 | 双獭会话 glm 撞 429：glm failed+诚实告知，kimi 照常；多消息各自独立快速失败；retry/新消息立即生效 |
| AT-7 | 分类修复 | 智谱「使用上限」文案→exhausted=true+resetHint 提取 |
| AT-8 | 告知分态 | exhausted 含重置时间+「手动重试/改派」出口，无「自动恢复」暗示 |
| AT-9 | 热池 | 容量上限驱逐最旧空闲；运行中不可驱逐；TTL 到期驱逐；驱逐后 restore 无缝；跨会话复用工具闭包正确刷新 |
| AT-10 | retry | 显式重传原消息→重新点火；游标不动 |
| AT-11 | 中断纯 abort | 中断端点/halt_otter 仅 abort 当前 invoke；无停机标记，其余独立信号照常 |
| AT-12 | 恢复去重 | steer 已消化消息后崩溃→恢复 invoke 不重复注入该消息（jsonl 尾部 msg id 匹配） |
| AT-13 | SSE/看门狗 | 判据迁移后行为等价（真实仓储集成测试）；busy 场景 SSE 30s 超时兜底关流 |

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| src/frameworks/agent/session-pool.ts | 新建 | LRU 热池（容量/TTL/驱逐守卫/工具闭包刷新） |
| src/frameworks/agent/pi-session-factory.ts | 大改 | 接热池；dispose 改留池；工具闭包刷新 |
| src/usecases/conversation/signal-router.ts | 大改 | busyQueue/闸门/阻尼/墙钟窗/销账删除；routeSignal 事件驱动 |
| src/usecases/conversation/dispatch-chain-engine.ts | 大改 | 游标启动成功推进+活跃度同点迁移；markBatchRead 删除；记账插桩删除；K2 预告改未读计数 |
| src/frameworks/db/conversation/sqlite-dispatch-attempt-repo.ts | 删除 | 台账退役 |
| src/entities/conversation/dispatch-attempt.ts | 删除 | 同上 |
| src/frameworks/db/migration.ts | 修改 | drop dispatch_attempts + signal_level 列退役说明 |
| src/usecases/conversation/query-signal-trail.ts | 删除 | 端点退役 |
| src/usecases/conversation/agent-turn-orchestrator/rate-limit-error.ts | 修改 | exhausted 文案+告警分态 |
| src/usecases/conversation/resume-interrupted-service.ts | 修改 | 恢复去重（出路 A） |
| src/usecases/scheduler/scheduler-service.ts | 修改 | 看门狗判据迁移消息终态 |
| src/interface-adapters/http/controllers/message-controller.ts | 修改 | SSE 关流判据迁移；G6 闸门文案移除；retry 去台账 |
| src/interface-adapters/http/router.ts | 修改 | /signal-trail 端点移除 |
| web/src/pages/conversation/GateBanner.tsx | 删除 | 闸门全退役 |
| src/frameworks/config-service.ts | 修改 | sessionPoolSize/sessionPoolIdleTtlMinutes 配置项 |
| tests/ 多处 | 修改/删除/新建 | 台账/queue/闸门测试删除；AT-1~13 新增（真实仓储集成） |

## 对抗审视记录

检视獭-rlcp（mimo，异模型）第一轮（对方案前身版本）：1 严重+4 建议全处置，
delta 复核 5/5 通过。此后搭档八轮过堂对方案做了根本重构（破而后立），
本版本为终态——PR 阶段需重新走代码级对抗审视。

**终审过堂修订留痕**（搭档逐问驱动）：
- D5 翻案：用户停机闸门退役（中断=纯终态，9/3 病根重燃已修）
- retry 语义：显式重传（游标不动；回拨会让 LLM 见两遍原文）
- 概念统一：档位全系统移除，followUp/steer/abort 三动作
- 底层：LRU 热池（容量默认 50），SDK followUp 接管忙时排队，锁与事件 B 退役
- steer 崩溃安全：出路 A（恢复侧取证去重），运行期零监听
- URGENT 树化：归下一版（热池是地基），四步编排与展示映射设计已备
