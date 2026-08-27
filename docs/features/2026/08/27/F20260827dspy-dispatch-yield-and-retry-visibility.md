---
id: F20260827dspy
title: 小獭 yield 回任务属主被链引擎吞掉（熔断重启后行动权悬空）+ message.retry 事件统一重试感知语义
summary: "#474：dispatch-chain-engine 的 nextTargets 过滤误把「scheduler 路径任务属主」当回声吞掉，小獭交付后 yield 回属主永不唤醒；改为只滤 'user'。#440：timeout 自动重试与 no_yield 重试在前端感知语义分叉，新增 message.retry SSE 事件统一告知「failed 是暂态」"
change_type: BugFix
created_in_conversation: 02e892ea-b291-4108-bacf-0d6148790511
capability_test: "n/a: 纯 A 类改动——链路由过滤与 SSE 事件发射均为代码决定，无 LLM 行为变量（断言失败用户可感知，行为契约测试覆盖）"
---

# F20260827dspy: #474 yield 交棒失效 + #440 重试感知语义统一

## 背景

### #474 现象（2026-08-26 实证）

石砧（mimo，issue #464 处理獭）经历熔断重启后完成交付（seq 243，PR #471 含完整根因分析），其 `yield to 大獭` 未触发大獭执行——用户在流式过程亲眼看到 yield 调用，但系统未唤醒大獭，最终用户手动 @大獭 接棒（seq 244）。

### #440 现象

timeout 类自动重试（streaming_timeout / first_byte_timeout / circuit_break）与 no_yield 重试在前端感知上语义分叉：前者发 `message.failed`（用户看到消息 failed「复活」为 streaming，无事件通知重试发生）；后者静默重置（前端 streaming 不中断）。PR #437 对抗审视建议发现 A1 提出，搭档评论拍板方向 2（新增事件，语义最诚实）。

## 根因分析（#474）

**数据库取证（data/otter-buddy.db，对话 3241317b-99d6-4d78-9248-ff208a7461bc）**：

| seq | 时间 (UTC) | 事件 |
|---|---|---|
| 241 | 02:33:13 | 石砧输出「正在熔断重启獭生」（failed）——熔断流程开始 |
| 242 | 02:48:27 | 系统保护消息：已重启獭生，自动继续执行 |
| 243 | 02:48:27–02:50:27 | 石砧交付报告，**completed 且 talking_stone_passed_to=[87f172c6…]（大獭）真实写库** |
| — | ~03:01 | 大獭从未被唤醒，用户手动 @（seq 244） |

seq 243 消息真实携带了指向大獭的 talking_stone——**yield 工具链、名字→ID 解析、消息落库全部正常**。断点在链引擎消费侧：

```ts
// dispatch-chain-engine.ts processHopResults（修复前）
nextTargets: [...nextTargets].filter(id => id !== senderId && id !== "user")
```

该链由定时任务「每日 issue 处理」（9007feea）触发，`scheduled_tasks.sender_id = 87f172c6…（大獭本人）`。链引擎的 `senderId` 即大獭 → 小獭 yield 回大獭时，目标被 `id !== senderId` 当成「回声」过滤 → `nextTargets=[]` → 链正常结束 → 大獭永不唤醒。

**为何只在 scheduler 路径发病**：Web 路径 senderId 恒为 `'user'`（人类，filter 的两个条件重复，行为无差）；scheduler 路径（AgentDispatchService / SchedulerService / ResumeInterruptedService）senderId 是任务属主 otter——`id !== senderId` 从防御性假设变成交棒吞没。

**git 考古**：该 filter 随 PR #116（F20260729imlo，8/1 抽取链引擎）从 message-controller 原样迁来，抽取时未重新审视「senderId 语义随调用方变化」这一隐含假设。

**与熔断重启无关**：熔断重启只改变消息时间线（石砧 02:50 完成），seq 243 的 yield 正常写入。8-26 现场即使无熔断，链尾 yield 回属主同样会被吞。#474 issue 标题归因「熔断重启后 yield 失效」是相关时序而非因果——修复定位在链引擎，不在 restart 链路（issue 待排查方向 1/2/3 均排除）。

## 方案设计

### #474：链引擎过滤只保留 'user'

```ts
// 修复后（dispatch-chain-engine.ts）
nextTargets: [...nextTargets].filter(id => id !== "user")
```

- 人类不参与链调度：`'user'` 照旧滤除（Web 路径等价回声，行为不变）
- 任务属主 otter：不再被过滤——小獭 yield 回属主 → 链续跳唤醒属主（编排闭环）
- 防环兜底：链层 maxChainDepth（默认 100，scheduler 链 15min 看门狗）；工具层 `validateAndResolve` 本就禁止 yield 传自己。自指回声（yield 回自己）由这两个既有防线覆盖，实测不构成死循环（回归测试断言）

### #440：新增 `message.retry` SSE 事件（方向 2，搭档拍板）

```ts
// api-contract/sse/events.ts
"message.retry": { messageId: string; otterId: string; otterName: string; reason: string; attempt: number };
```

发射点（orchestrator）：

1. **timeout 类 auto-retry**（handleAutoRetry）：`message.failed` 后紧跟 `message.retry`（reason=「生成过程超时」等人类可读文案）——前端明确知道 failed 是暂态
2. **no_yield 首轮重试**（handleYieldRetry）：`failMessage` 后同样补发（reason='no_yield'）——该路径 fail 本就不发 message.failed，补发 retry 事件向前端声明「正在重试」，两条路径感知语义统一

前端消费（web/src/pages/conversation/index.tsx，三处 handler 同行为）：收到 `message.retry` → 消息 status 回退 `'streaming'`、`dur=null`，重建 live 跟踪状态（liveEventsMap/liveMeta）——后续 speak.intermediate / message.complete 照常接管。旧客户端不订阅该事件不崩溃（handler Partial），退化为此前的轮询感知。

## 非目标

1. 不动 scheduler 15 分钟链看门狗与静默容忍窗语义（#516，PR #522 另行修复）
2. 不动 #517 吞错记账路径（同 PR #522）
3. 不做「timeout 重试不发 message.failed」的反向方案（方向 1，已被搭档评论否决——failed 是事实不应隐瞒）

## 影响范围

| 文件 | 变更 |
|---|---|
| src/usecases/conversation/dispatch-chain-engine.ts | filter 收窄为只滤 'user' |
| api-contract/sse/events.ts | SSEEventMap 新增 message.retry |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | handleAutoRetry / handleYieldRetry 补发 message.retry |
| web/src/pages/conversation/index.tsx | 三处 handler 新增 message.retry 处理 |
| tests/usecases/conversation/dispatch-chain-engine.test.ts | 3 用例：scheduler 续跳 / web 滤 user / 自指不环 |
| tests/interface-adapters/agent-invoker.test.ts | 2 用例：timeout 路径事件序列 / no_yield 路径事件 |

## 测试与验证

- `tests/usecases/conversation/dispatch-chain-engine.test.ts` 新增 3 用例：
  - scheduler 路径（senderId=owner-otter）：小獭 yield 回属主 → 链续跳 invoke 属主（回归 8-26 现场）
  - web 路径（senderId=user）：yield to user 仍被滤除（人类不参与链调度）
  - 自指回声：持续 yield 回自己不构成死循环（maxChainDepth=10 内终止）
- `tests/interface-adapters/agent-invoker.test.ts` 新增 2 用例：
  - streaming_timeout：message.failed 之后紧跟 message.retry，字段（messageId/reason/attempt）齐全且顺序正确
  - no_yield：fail 后补发 message.retry（reason=no_yield）
- 全量：主仓 vitest 148 文件 1751 用例全绿；web 26 文件 217 用例全绿；两端 tsc --noEmit 零错；eslint 零告警

## 关联

- Fixes #474、Fixes #440
- PR #437（#440 来源）、PR #522（#516/#517，scheduler 看门狗——同链路相邻修复，无代码重叠）
- F20260818sgmt（speak-yield 拆分协议）、F20260821rtmx（prepareForRetry 无缝重试）

## 对抗审视记录（2026-08-27）

### 首轮（审砚，mimo × 实现者石锛 glm，异模型）

**基础维度**：B1 CI 绿 / B2 文档完整 / B3 全链路验证独立复跑通过 / B4 标识一致。**0 严重 + 2 建议**。

| 发现 | 分级 | 处置 | 理由 |
|---|---|---|---|
| 1. message.retry 的 attempt 硬编码为 1（orchestrator.ts:502） | 建议 | **接受并修复** | 当前策略（retryCount===0 才触发）下语义正确但属隐含假设；改为 `ctx.input.retryCount + 1` 消除假设且零成本。同款问题在 no_yield 路径（:532，本 PR 新增代码）一并修复。两处守卫均为 `retryCount === 0`，运行时值不变（仍为 1），现有断言 `attempt).toBe(1)` 无需改动 |
| 2. self-yield 防环仅剩 maxChainDepth=100 兜底 | 建议 | **建 issue #530** | 认同审砚判断：filter 收窄是正确的语义修复，self-loop 加固是独立的防线增强，合并会稀释 #474 修复焦点。issue 内注明方向 A（processHopResults 内区分 self-yield 与 owner-yield 的提前终止）与方向 B（降 scheduler maxChainDepth 配置） |

### 验证补充

- agent-invoker.test.ts 35 用例全绿（含 2 个 message.retry 用例）
