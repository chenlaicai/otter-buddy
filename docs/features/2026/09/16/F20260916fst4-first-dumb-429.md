---
id: F20260916fst4
doc_type: feature
change_type: feature
capability_test: "n/a: 纯编排逻辑（chain-engine 首哑信号生成 + 大獭 prompt 处置指南），无 LLM 行为 golden 场景可回归；行为由单测覆盖：chain-engine 首哑判定（new=true 且首次 invoke 终态 failed 且 rate_limit exhausted）+ pending 存取（写入/消费/幂等）+ 大獭 invoke 注入拼接"
title: "小獭首哑 429 大獭兜底：新建小獭首次 invoke 配额耗尽时唤醒大獭处置"
summary: "大獭新建小獭并派工后，若小獭首次 invoke 即配额型 429 终态（首哑），链引擎不再静默终链——向大獭生成一次性「首哑信号」使其被 invoke 唤醒，注入小獭名/模型/错误摘要/原派工任务 + 处置指南（restart_otter 换模型复活为推荐路径），由大獭按 L1 自治处置。运行中 429 维持现状不升级（搭档 2026-09-16 边界收敛）。"
feature_id: F20260916fst4
created_in_conversation: 83978b8e-e7b9-4d8f-a8c3-53b721676a12
created_at: 2026-09-16
intent:
  problem: "大獭拉小獭时小獭首次发言即 429，链静默终止，大獭永远不知道派工失败，协作卡死必须搭档人工介入"
  expected_effect: "首哑场景大獭被唤醒并处置（降级复活/换人/上报），搭档只在例外路径被升级"
  verify_by:
    type: unit_test
modules:
  - conversation/dispatch-chain-engine
  - agent-runtime/agent-invoker
  - healing
tags:
  - rate-limit
  - model-fallback
  - orchestration
  - otter-dispatch
---

## 背景

搭档原话（意图锚，2026-09-16）：

> 「我最近发现一个难点，那就是某些模型可能会用完token，但是大獭拉小獭时也还是会用到这些模型，然后又立马报错429。然后协作就停下来，必须我来介入」

边界收敛（同日，L2 拍板）：

> 「当大獭*新建*一个小獭，并且小獭首次就429时，此时需要大獭来介入处理。至于运行过程中的429，我认为可以暂时不传递给大獭处理」

现状（代码核实）：

1. 小獭 429 → `orchestrator.handleApiError`（agent-turn-orchestrator/orchestrator.ts:250）→ 落 healing 账（exhausted=high）+ `notifyRateLimit` 发系统消息 + `failTerminal`（:793）终止 invoke。
2. **行动权不回流**：chain-engine `resolveHopOutcomes`（dispatch-chain-engine.ts:302）只从产出 invoke 的 `talkingStonePassedTo` 路由下一跳；invoke failed = 无 tsp → `nextTargets` 为空 → **链静默终止**。大獭作为派工方永远收不到失败通知。
3. 告警补送达是被动管道：high 级入 C3 队列（healingAlertRegistry），但**只在大獭下一次 invoke 时注入**；没人 invoke 大獭 = 队列滞留 = 死锁。
4. `create_otter` 前置提示（tool-factory.ts:269）仅软警告且只防新创建，不救已中断。

已有相关机制：#843 ModelFallbackService（内存态降级，当前消费点 = pi-session-factory 模型解析，主要救定时任务场景）；#543 429 告警层（healing 落账 + C3 队列）。

## 目标

T1：大獭新建小獭（conversation 内 `create_otter`）且其首次 invoke 因配额型 429 终态失败时，大獭被显式 invoke 唤醒，拿到结构化失败上下文（小獭/模型/错误/原派工任务）。

T2：大獭被唤醒后有明确处置指南：默认推荐 `restart_otter(小獭, modelAlias=fallback)` 原地复活续派（L1 自治，可见留痕），复活失败/无可用模型时升级搭档（附决策简报）。

T3：运行中（非首次 invoke）的 429 维持现状（系统消息 + healing 落账），不升级大獭。

## 非目标

- **不做运行中 429 的大獭升级**（搭档显式收敛边界，后续视首哑效果再议）。
- **不做系统自动 fallback**：复活动作由大獭（LLM）显式调用 `restart_otter` 完成，处置权在獭不在黑盒（延续 9/15 否决 #843 全自动 fallback 的精神）。
- **不改 #843 ModelFallbackService 的定时任务路径**。
- **不处理大獭自身首哑 429**（大獭 invoke 失败没有「上一级獭」可升级，维持现状 = 系统消息 + healing；搭档感知靠 Web UI 红色终态）。
- **不做失败重试链**：首哑信号只发一次，大獭复活的小獭再次首哑时走「运行中 429」路径不再升级（防无限复活循环）。

## 方案设计

### 核心机制：首哑信号（first-dumb signal）

**触发判定**（chain-engine `resolveHopOutcomes` 附近，settle 阶段）：

invoke 终态 failed 且同时满足：
1. invoke 的 `errorMessage` 命中 `matchRateLimitError` 且 `exhausted === true`（复用 #543 纯函数，agent-turn-orchestrator/rate-limit-error.ts:56）；
2. 该 invoke 是小獭在本 conversation 的**首次 invoke**（`invokes` 表按 otterId+conversationId count==1，或该 otter participant `joinedAtTurnNumber` 与当前 turn 相邻——实现时取最简可靠口径）；
3. 该小獭由 `create_otter` 创建（otter 类型 small），且 conversation 内有大獭在场可接棒。

**检测点（delta 修订，原 settle 方案不可行）**：orchestrator `handleApiError`（agent-turn-orchestrator/orchestrator.ts:250）——此处已有 `matchRateLimitError` 结果（exhausted 判定）、`ctx.input`（otterId/conversationId/invokeId/originalUserMessage/senderId），是错误类型信息的终端汇聚点。原方案设想的 chain-engine settle 检测点经审视证实数据流断裂：`failTerminal` 返回的 TurnResult 经 agent-invoker 转为 fulfilled 的 `InvokeFnResult`（仅含 messageId/aggregatedTargets），错误类型在跨层时被丢弃；且 chain-engine 反向调用上游 AgentDispatchService 会形成循环依赖。

**检测信号定义**（TurnResult 新增字段，对齐 `_circuitBreak` 跨层信号模式，types.ts:74 先例）：

```ts
_firstDumb?: {
  otterId: string;          // 首哑小獭
  conversationId: string;
  modelAlias: string;       // resolveModelAlias(ctx) 既有
  resetHint?: string;       // 配额重置提示（东八区中文时间原文）
  errorMessage: string;     // 截断 500 字符
  originalUserMessage: string; // 原派工任务（截断 500 字符，复活摘要素材）
  failedInvokeId: string;
}
```

orchestrator `handleApiError` 内、healing 落账后：查 `getInvokeCount(conversationId, otterId) === 1`（当前 failed invoke 已入库，count==1 即首次；retry 走同 invoke 不增 count，天然幂等）+ 小獭 type === 'small'（`getOtterById` 已返 type，undefined 视为非 small 不命中）。命中 → **先构造 `_firstDumb` 挂到返回值，再调 failTerminal**（delta 复核建议 2：`failTerminal` 返回 `{invokeId, duration}`，实现为 `const result = await this.failTerminal(...); return {...result, _firstDumb}`，不改 failTerminal 签名）。

**信号消费**：agent-invoker 在 `executeTurn` 返回后（`handleCircuitBreakSignal` 同位置，agent-invoker.ts:293 附近）检测 `_firstDumb` → fire-and-forget 触发大獭 dispatch（`void this.handleFirstDumbSignal(...)`）：
1. 查 conversation 参与者找大獭（type==='big'）；无大獭在场 → 降级维持现状（healing 已落账，告警已发）；
2. **先** `healingAlertRegistry.enqueue` 一条 firstDumb alert（事件本体，大獭 buildDynamicContext 的 takeAll 消费，agent-invoker.ts:248 既有逻辑）；
3. **再** await 写 system entry（搭档可见留痕：「小獭 X（模型 Y）首次发言即配额耗尽，已唤醒大獭处置」）；
4. **再** 调 `AgentDispatchService.dispatch({conversationId, userMessageContent: <结构化处置指令>, senderId: 'system', resolvedTargets: [bigOtterId]})` → fireDirectChain 直连链点火大獭（agent-dispatch-service.ts:127 既有路径，fire-and-forget 不嵌套当前链）。

时序保证（2→3→4 严格串行）：alert 入队先于大獭 invoke 的 `buildDynamicContext`，首哑上下文必达。

**处置指令文本**（作为大獭的 userMessageContent，自包含——不依赖 alert 送达，双通道冗余）：

```
[首哑告警] 你新建的小獭「<名字>」（模型 <alias>）首次发言即配额耗尽（429 终态<，重置提示：xxx>）。
原派工任务：<originalUserMessage 截断>。
处置决策树：
1. 首选 restart_otter(otterId, modelAlias=<可用fallback>, summary=<任务摘要>) 原地复活，然后重新 yield 派工；
2. 无可用 fallback / restart 失败 → 升级搭档（附决策简报）；
3. 复活后再次 429 → 走运行中路径，不再升级。
```

**大獭 prompt 侧指南**：大獭系统 prompt 增一段「首哑处置」说明（收到 [首哑告警] 时按上述决策树执行，复活动作为 L1 自治，升级搭档必须附决策简报）。

### 涉及模块

| 模块 | 改动 |
|---|---|
| `agent-turn-orchestrator/types.ts` | TurnResult 新增 `_firstDumb` 信号字段；TurnCallbacks 新增 `getInvokeCount(conversationId, otterId): Promise<number>`（首哑判定数据源，SELECT COUNT 轻量口径——delta 复核建议 1 采纳） |
| `agent-turn-orchestrator/orchestrator.ts` | `handleApiError` 内 exhausted 分支增首哑判定（count==1 + type==='small'），命中挂 `_firstDumb` |
| `agent-invoker.ts` | executeTurn 返回后检测 `_firstDumb` → handleFirstDumbSignal（enqueue alert → system entry → dispatch 大獭），对齐 `handleCircuitBreakSignal` 模式；新增 AgentDispatchService 依赖注入 |
| `healing-alert-registry.ts` | HealingAlert 载荷扩展 `firstDumb?` 上下文字段（可选，description 已自包含时可省） |
| 大獭系统 prompt（identity-builder / prompts） | 首哑处置决策树指南段 |
| 单测 | orchestrator 首哑判定 3 用例（首次 exhausted 命中 / 非首次不命中 / 瞬时不命中）+ invoker 信号消费 3 用例（dispatch 触发 / 无大獭降级 / 时序：enqueue 先于 dispatch） |

## 影响范围

- orchestrator `handleApiError`：exhausted 分支新增一次 invoke 计数查询 + 条件挂信号，未命中时零行为变化；
- agent-invoker：新增 `_firstDumb` 消费分支（同 `_circuitBreak` 位置），新增 AgentDispatchService 依赖（装配链 platforms.ts 透传）；
- 大獭 prompt：新增一段处置指南（~15 行）；
- healing/C3：复用既有通道，无新表无新持久化；
- chain-engine：**零改动**（检测点不在此处——delta 修订后本模块出列）。

## 风险与约束

- R1 首哑判定口径：`getInvokes(conversationId, {otterId})` count==1——当前 failed invoke 已入库（failTerminal 先于计数查询），retry 走同 invoke 不增 count，天然幂等；非 429 失败重试产生新 invoke 后 count>1 不再升级（恰好是期望行为）；
- R2 大獭自己也不可用时（大獭模型 429）：首哑 dispatch 的大獭 invoke 自身 failTerminal → 回到现状（系统消息 + healing 可见），不引入新死锁，只是不救这个场景（见非目标）；
- R3 多小獭同时首哑（批量召唤遇池级 429）：每只各自触发一次 dispatch（fireDirectChain 各自独立链）——大獭可能收到多条首哑指令，LLM 天然可批量处置；alert 队列上限 20 防积压；
- R4 死循环防护：复活后小獭第二次 invoke 时 count==2 → 首哑判定不命中 → 走运行中路径，硬切断；`_firstDumb` 信号只在 exhausted + 首次时挂，瞬时 429/其他错误不触发；
- R5 与 `_circuitBreak` 互斥语义（delta 复核确认）：两者在不同错误路径（circuit break 走 finalizeInvokeFailed，rate_limit 走 failTerminal），invoker 检查顺序 circuit break 优先——系统级保护优先于场景级信号，语义正确。

## 设计取舍

**机制识别检查点**：命中「新增信号类型/消息格式」（首哑信号）+「新增决策分支（其结果影响后续行为）」→ 机制预算四问必答：

1. **谁需要它**：大獭（编排者）——派工失败时需要知道并兜底处置；搭档——不再为首哑人工接棒。
2. **失败后果**：信号丢失/误报 → 回到现状（搭档人工介入），不会比现状更差；误报（非首哑误判为首哑）→ 大獭多一次无效唤醒，代价一次 invoke。
3. **后续机制**：新状态 = 「大獭被首哑唤醒后处置不当」（如无限复活）——由「复活后再次 429 走运行中路径不再升级」硬切断；判定口径 bug 由单测 + 每日 review 观测 healing 事件分布兜底。
4. **退役条件**：运行中 429 升级大獭的完整版方案落地时（届时首哑是其子集），或 #843 降级器扩展到协作场景全自动兜底且搭档接受时。

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 复活动作谁执行 | 大獭 LLM 显式调 restart_otter | 系统自动 fallback（链引擎内直接换模型重试） | 搭档 9/15 否决全自动的精神：处置权在獭可见可否决；且大獭可根据任务性质选「换人」而非「换模型」 |
| 信号载体 | TurnResult `_firstDumb` 字段（对齐 `_circuitBreak` 跨层模式）+ C3 队列 + fireDirectChain | chain-engine settle 检测 / 新建独立信号管道 | settle 点拿不到错误类型（InvokeFnResult 不含 error 字段，failTerminal 跨层后 fulfilled 化）；chain-engine 反调上游 dispatch 循环依赖。`_circuitBreak` 是同形态问题的已验证解法 |
| 判定位置 | orchestrator handleApiError | chain-engine settle 阶段 | orchestrator 是错误类型信息终端汇聚点（match 结果 + TurnInput 全上下文）；且持有 originalUserMessage（复活摘要素材） |
| 时序保证 | enqueue alert → system entry → dispatch 严格串行 | fire-and-forget 入队与 dispatch 并发 | alert 必须先于大獭 invoke 的 buildDynamicContext，否则大獭错过首哑上下文（处置指令文本自包含双通道兜底，但 alert 通道不白丢） |
| 运行中 429 | 不升级（现状） | 一并升级 | 搭档显式收敛边界 |

## 验证

- 单测：orchestrator 首哑判定（首次 exhausted 命中挂信号 / 非首次 count>1 不挂 / 瞬时 429 不挂 / 非 small 獭不挂 / `matchRateLimitError` 解析失败 match=null 不挂——delta 复核建议 3）+ invoker 消费（_firstDumb → dispatch 被调且目标为大獭 / 无大獭在场降级不 dispatch / enqueue 先于 dispatch 调用序断言）；
- 集成：模拟小獭首次 invoke 429 → 断言大獭被 dispatch 且处置指令含小獭名/模型/任务摘要、system entry 落库、alert 入队；
- 回归：全量 vitest 既有用例零回归（orchestrator / invoker / chain-engine 全部）；
- 实演：用配额耗尽的模型新建小獭走一遍真实链路。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/usecases/conversation/agent-turn-orchestrator/types.ts | M | TurnResult `_firstDumb` 字段 + TurnCallbacks `getRecentInvokes` |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | M | handleApiError 首哑判定挂信号 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | M | `_firstDumb` 消费 + handleFirstDumbSignal + AgentDispatchService 注入 |
| src/usecases/healing/healing-alert-registry.ts | M | alert 载荷可选扩展（可省） |
| 大獭系统 prompt 注入点 | M | 首哑处置决策树指南 |
| src/bootstrap/platforms.ts | M | AgentDispatchService 装配透传 |
| tests/usecases/conversation/agent-turn-orchestrator/*.test.ts | M | 首哑判定用例 |
| tests/interface-adapters/agent-runtime/agent-invoker*.test.ts | M | 信号消费用例 |

（M=修改，无新增文件——预计净增 <180 行）

## 决策史（对抗审视记录）

**第 1 轮（检视獭-首哑，mimo）**：3 严重 + 2 建议。

- 严重 1（settle 阶段拿不到错误类型，数据流断裂）：**接受**。核实属实——`failTerminal` 返回 TurnResult 经 invoker 转 fulfilled 的 `InvokeFnResult`（仅 messageId/aggregatedTargets），resolveHopOutcomes 只见 status='failed' 的 invoke 行无 errorMessage。处置：检测点前移至 orchestrator `handleApiError`，信号经 TurnResult `_firstDumb` 跨层（对齐 `_circuitBreak` 已验证模式）。
- 严重 2/3（chain-engine 无 dispatch 依赖、反调上游循环依赖）：**接受**。核实属实——chain-engine deps 无 AgentDispatchService/sendEntry，且 AgentDispatchService 是其上游调用方。处置：dispatch 触发移到 agent-invoker（handleCircuitBreakSignal 同位置），invoker 新增 AgentDispatchService 依赖，走 `resolvedTargets` 直连链路径。
- 建议 4（count 口径优于 joinedAtTurnNumber）：**接受**，已采纳为唯一口径。
- 建议 5（enqueue 必须先于 dispatch 的时序保证）：**接受**。处置：消费三步严格串行（enqueue alert → system entry → dispatch），且处置指令文本自包含双通道冗余。
- 重对抗门：疑似治标（符合预期的 stepping-stone）——作者认同，方案自身定位即搭档边界收敛下的第一刀，退役条件已在文档声明。

修订后请检视獭做 delta 复核。

**Delta 复核（检视獭-首哑，mimo）：通过**。三个验证点全过：①`_firstDumb` 通道解决数据流断裂（orchestrator 有 match 结果 + resolveModelAlias 既有调用）；②与 `_circuitBreak` 互斥无冲突（不同错误路径，circuit break 优先语义正确）；③时序串行在 fireDirectChain fire-and-forget 下成立（enqueue 同步先于 dispatch，alert 必在 takeAll 前入队）。

delta 建议 3 条全部采纳：
- 建议 1：`getRecentInvokes` 改 `getInvokeCount`（SELECT COUNT 轻量口径）——已回写模块表与判定段；
- 建议 2：明确 `_firstDumb` 挂在 failTerminal 返回之后（`{...result, _firstDumb}`，不改 failTerminal 签名）——已回写判定段；
- 建议 3：`matchRateLimitError` 解析失败路径纳入单测——已回写验证段。

方案定稿，呈搭档终审。
