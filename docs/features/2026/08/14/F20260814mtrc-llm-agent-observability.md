---
id: F20260814mtrc
title: llm-agent-observability
doc_type: feature

summary: |
  为 LLM/agent 核心链路接入 metrics 与 trace 关联。
  动机：当前 metrics 仅 scheduler 域接入，token/延迟/重试/退出原因只有日志可 grep，
  mimo 退化、重试死循环、熔断等问题排查缺乏量化数据，后续插件化重构也缺少行为不变性的证据基线。
  主机制：新增 AgentMetrics（invoke/工具/token/首字节/重试/守卫中断/compaction/session 重建/链深指标，
  埋点收敛在 AgentInvoker 的退出分类与收尾汇合点）+ 基于 AsyncLocalStorage 的 TraceContext
  （链级 traceId 串联全链路日志）。

causal_links:
  from:
    - F20260813rstrt

status: development
change_type: feature
tags: [observability, metrics, agent]
modules:
  - src/frameworks/metrics/agent-metrics.ts
  - src/usecases/ports/trace-context.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/frameworks/logger.ts
  - src/frameworks/agent/pi-session-factory.ts
capability_test: "n/a: 纯软件边界内改动（A 类），无 LLM 参与行为变化"
created_in_conversation: observability-design
---

# F20260814mtrc: LLM/Agent 链路可观测性

## 背景与需求

### 问题描述

可观测性现状（调研结论）：

1. **metrics 覆盖失衡**：`MetricsRegistry`（prom-client，全局单例，`/metrics` 端点 + 60s JSONL flush）已就绪，但唯一消费者是 `SchedulerMetrics`。LLM/agent 核心链路（invoke 次数、token、耗时、首字节延迟、重试、守卫中断、工具调用）**零 metrics**——全部信息只存在于结构化日志中。
2. **无 trace 概念**：一次用户消息触发的发言链（多 hop、多 otter、可能重试）在日志中只能靠 `messageId`/`conversationId` 手工 grep 串联，没有链级关联 ID。
3. **真实痛点驱动**：mimo 复读退化、重试死循环（session reset 熔断讨论）、熔断器触发等问题的频次分布、重试成功率完全没有量化数据，判断"是否需要 session reset 熔断"这类决策缺乏依据。

### 根因分析

metrics 骨架（registry/flush/端点/过期清理）与领域 metrics 模块（SchedulerMetrics 模式）都已存在且被验证，缺的只是 agent 域的指标定义与埋点。这不是基础设施问题，是"最后一公里"问题。

### 数据实锤

- `data/metrics/metrics-*.jsonl` 现存内容仅 `scheduler_*` 系列。
- `AgentInvoker`（`src/interface-adapters/agent-runtime/agent-invoker.ts`）中 `'Agent invocation started'`/`'Agent invocation completed'` 等日志字段已含 tokenUsage/duration，但仅入日志。
- 工具事件（`tool_execution_start/end`）携带 `toolCallId`（circuit-breaker 已按此配对计时），工具级 duration 可配对统计。

## 方案设计

### 技术方案

#### Part 1：AgentMetrics 指标模块

新增 `src/frameworks/metrics/agent-metrics.ts`，沿用 `SchedulerMetrics` 模式（构造注入 `MetricsRegistry`，领域方法封装 label 组装）。在 `app.ts` 装配后经构造函数可选注入 `AgentInvoker`（与 `messageBroadcaster` 同模式，缺省 undefined 时全部 no-op，不破坏现有测试）。

指标清单：

| 指标 | 类型 | label | 埋点位置 |
|------|------|-------|---------|
| `agent_invoke_total` | counter | `model, otter_type, source, outcome, retry` | success 在 `completeAgentInvocation`；四类失败在 `classifyAndRoute` 分类后、路由前 |
| `agent_invoke_duration_ms` | histogram | `model, otter_type, outcome` | 同上（attempt 级计时，见口径） |
| `agent_token_input_total` / `agent_token_output_total` | counter | `model, otter_type` | 同上（**attempt 增量**，见口径） |
| `agent_context_tokens` | histogram | `model, otter_type` | 同上（`result.ctxTokens`，上下文窗口占用分布） |
| `agent_first_byte_latency_ms` | histogram | `model` | 成功路径 `result.outputGuardMetadata.firstByteLatencyMs`；guard abort 路径从 err 附加元数据提取（见逻辑变更） |
| `agent_retry_total` | counter | `kind` | SDK 层（onEvent `auto_retry_start`）+ invoker 层三条重试路径入口 |
| `agent_guard_abort_total` | counter | `model, reason` | `classifyExit` 产出 guard_abort 时 |
| `agent_tool_calls_total` | counter | `tool` | onEvent `tool_execution_start` |
| `agent_tool_duration_ms` | histogram | `tool` | onEvent 按 `toolCallId` 配对 start/end |
| `agent_tool_errors_total` | counter | `tool` | onEvent `tool_execution_end` 且**事件顶层** `e.isError === true` |
| `agent_compaction_total` | counter | `reason, aborted` | onEvent `compaction_end` |
| `agent_session_rebuild_total` | counter | — | invoke 结果携带 `sessionRebuilt`（session 丢失/损坏/重启重建） |
| `agent_chain_hops` | histogram | — | `DispatchChainEngine.executeChain` 链结束 |
| `agent_chain_depth_exceeded_total` | counter | — | `executeChain` 触达 maxDepth |

**histogram buckets**（显式定义，prom-client 默认桶对本量级全部落 +Inf）：

- `agent_invoke_duration_ms`：`[500, 1e3, 5e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3]`（量级：首字节秒级～guard 超时 600s）
- `agent_tool_duration_ms`：`[10, 50, 100, 500, 1e3, 5e3, 10e3, 30e3, 60e3, 120e3]`
- `agent_first_byte_latency_ms`：`[100, 250, 500, 1e3, 2500, 5e3, 10e3, 30e3, 60e3]`
- `agent_context_tokens`：`[1e3, 5e3, 1e4, 2e4, 5e4, 1e5, 1.5e5, 2e5]`（`TOKEN_WARNING_THRESHOLD=100k` 落在桶间）
- `agent_chain_hops`：`[1, 2, 3, 5, 8, 13, 20, 50, 100]`

**口径设计**：

- **attempt 粒度**：`agent_invoke_total` 按"一次 invoke 尝试"计数。重试会再次进入 invoke 路径，各算一次 attempt。attempt 成功率 = `outcome="success"` 计数 / 总计数。
- **outcome 枚举**（封闭）：`success`（speak 完成，含 speaking-guard 收尾）/ `user_abort` / `guard_abort` / `api_error` / `no_speak_retry`（首轮未 speak 触发重试）/ `no_speak_failed`（重试后仍未 speak）。
- **retry label**（封闭）：`"0" | "auto" | "manual"`。manual = Web 手动重试（`message-controller.retry`），与系统自动重试区分，避免稀释自动重试成功率。手动重试在 `invokeConversation` 增加可选参数标识。
- **source label**（封闭）：`"chain" | "direct"`。chain = 经 `DispatchChainEngine.executeChain`（Web SSE/飞书/招聘桥）；direct = 直连 `invokeConversation`（scheduler、Web 手动重试），由 trace 兜底生成处区分。更细入口归因（web vs feishu）推迟到有真实需求时。
- **model label**：`modelAlias`（多模型池现成值，基数=池大小）。**mimo 退化归因是本档第一动机**，guard_abort/first_byte/duration 不按 model 拆分则无法回答"退化是 mimo 特有还是全池现象"。取值自 invoke 结果新增的 `modelAlias` 字段。
- **token attempt 增量**：`result.tokenUsage` 是 **session 累计值**（`getSessionStats()` 跨 invoke 单调累积，invoke-port 注释明示）。AgentMetrics 内部按 `otterId` 缓存上次累计快照，attempt 增量 = `cur - last`；`cur < last`（session 重置/重建）时取 `cur` 全量。缓存 keyed by otterId（基数=獭数），不入 label。
- **guard reason 枚举**（封闭 + 归一化）：`degenerate_output | streaming_timeout | first_byte_timeout | circuit_break | internal_abort | other`。`circuit_break:*` 归一化为 `circuit_break`，未知值归 `other`。
- **duration 语义**：`agent_invoke_duration_ms` 含前置开销（DynamicContext 构建、session 锁等待 `session:{otterId}`、排队），与纯 LLM 的 `first_byte_latency_ms` 不可直接对照，文档明示。**speak-retry 的第二 attempt 使用 attempt 入口时间**（`retryInvokeOnSameMessage` 复用外层 startTime 是链级口径，直方图会双计 wall-clock，故 metrics 单独计时）。
- **label 基数控制**：严禁 `messageId`/`otterId`/`conversationId`/`errorMessage` 入 label；这些归属日志维度，靠 traceId 关联（Part 2）。
- **otter_type 获取**：埋点处 `queryOtter.getById` 一次（SQLite 主键读；查不到记 `unknown`）。
- **attempt 记录恰好一次**（PR 审视 P0 修复）：以 `messageId:retryCount` 为去重键——`routeByReason` 抛错被外层 catch 捕获后**重入** `classifyAndRoute` 时（重入分类通常产出虚假 `api_error`），去重键阻止同一 attempt 二次记录。键在 `invokeConversationInner`/`retryInvokeOnSameMessage` 的 finally 中清理（重入只可能发生在该窗口内）。
- **err 路径 model 回退**（PR 审视 P1 修复）：guard abort 主路径走 throw（result 不可达），`pi-session-factory` catch 分支在 error 上附加 `_modelAlias`，随 `_outputGuardMetadata` 一起带出——否则失败样本（恰是超时/退化关心的那批）model 全落 `unknown`，归因失效。
- **重试计数语义**：`agent_retry_total` 计的是"重试意图"——个别降级路径（sendSystem 失败转 abort）计入但二次 invoke 未实际发生。invoker 层的重试意图计数在**退出分类点**与 attempt 记录共用同一去重键（PR 四审修复：路由方法内散落计数在"路由抛错 → 重入"场景会双计）。
- **已知漏计**（PR 审视确认接受，总量守恒或影响可忽略）：
  - `invokeConversation` try 块之前（`sendMessage.start` 等）抛错不产生 attempt 记录（罕见路径，上层有 error 日志）。
  - err 路径 `tokenUsage` 不可得、快照不更新——失败 attempt 烧掉的 token 被**下一次成功 attempt 的差分吸收**（归因到成功 attempt 的 model），总量不虚增。
  - `sessionRebuilt` 仅在成功结果上透传——重建后紧跟失败的 invoke 不计 `agent_session_rebuild_total`。
  - 同一 registry 重复构造 AgentMetrics 会共享 counter 但重置 token 快照（生产单次装配不触发；测试用独立 registry）。
  - `lastTokenSnapshot` 按 otterId 键控，隐含 otter↔会话 1:1 假设（现行域模型成立）；未来解除该假设需改为按 session 键控。
- **无 end 事件的工具调用**（abort 中断）：不记 duration（Map 等 GC 回收），start 计数已如实反映。`toolCallId` 缺失时防御性跳过配对（对齐 circuit-breaker 先例）。

#### Part 2：TraceContext 链路追踪

新增 `src/usecases/ports/trace-context.ts`（ports 层原因：usecases 与 frameworks 都要消费，frameworks→usecases 方向合法，反向不行）：

```ts
export interface TraceContext {
  traceId?: string;   // 发言链级：一次用户消息 → 完整多 hop 链
  messageId?: string; // invoke 级：当前 streaming 消息
  source?: string;    // "chain" | "direct"（与 metrics source label 同源）
}
```

- 基于 `AsyncLocalStorage`（仓库已有先例：`pi-session-factory` 的 `otterInvokeStorage`）。事件回调（SDK 同步 `_emit`）、fire-and-forget promise 续体均按 Node ALS 语义继承 scope，不逃逸。
- `runWithTrace(patch, fn)`：**defined-only merge**——子 scope 只覆盖显式传入的字段，父 scope 的 traceId 自动保留。
- traceId 格式：`t_` + 12 位随机 hex，生成时打印进 invoke 开始日志。

**注入点**：

| 注入点 | 注入字段 | 覆盖路径 |
|--------|---------|---------|
| `DispatchChainEngine.executeChain` | `traceId`（新链生成）+ `source="chain"` | Web SSE、飞书、招聘桥 |
| `AgentInvoker.invokeConversation` | 兜底：无 traceId 时生成并置 `source="direct"`（scheduler、Web 手动重试直连路径）；执行段补 `messageId`（`retryInvokeOnSameMessage` 同样补） | 全量汇合点 |

兜底生成不告警（direct 是 scheduler 的**常态**路径，warn 会刷屏）；入口归因由 `source` label 承担。**已知局限**：Web 手动重试生成的新 traceId 与原链无关联（原 messageId 可在日志中手工衔接，不做自动关联）；飞书 `triggerAgentDispatch` 的 `.then/.catch` 收尾回调在 trace scope 外，其日志不带 traceId（对 fire-and-forget 回调逐个包裹属过度工程，接受）。

**日志富化**：`PinoLogger` 四个日志方法统一合并 `getTraceContext()` 的 `traceId`/`messageId` 到 context（frameworks→ports 方向合法，registry.ts 先例）。**显式 context 字段优先于 trace 字段**（`{...traceFields, ...context}`，与 error() 现有合并语义一致）。效果：链上所有日志自动携带同 traceId，日志↔metrics 按时间轴对齐；不改任何现有调用点。child logger 同样生效（方法级富化在包装层）。

**不引入 OpenTelemetry**：当前消费场景是单机自托管 + JSONL/Prometheus 文本，OTel SDK 是为分布式 tracing 准备的重量设施，ALS + 日志富化已满足"链路串联"诉求。引入 OTel 留给未来真有多服务时再评估（反投机基建原则）。

#### 指标语义契约（对插件化重构的锚定）

以下定义是**对外承诺的公共契约**，未来插件化重构无论内部控制流怎么拆（classifyAndRoute/handleXxx 私有方法群预计会被重组），这组指标的定义与口径不变，保证重构前后基线可比：

1. attempt 语义与 outcome 六枚举
2. retry 三值、source 两值、guard reason 封闭枚举
3. token attempt 增量口径
4. traceId 链级语义

埋点实现可以随重构迁移位置，指标语义不许漂移。重构 PR 必须对照本节自检。

#### 消费闭环

- **消费节奏**：事故排查时（退化和重试问题出现场）随查随看；无固定巡检。
- **JSONL 消费**（60s 全量累计快照，指标值 = 末次快照 − 首次快照。**Caveat**：进程重启后 counter 归零，跨重启时段的首末 diff 会低估甚至出负数——排查时优先看当日无重启的区间，或直接 `curl /metrics` 看内存累计值）：

```bash
# 当日 attempt 成功率与退出原因分布（同 label 组首末快照 diff）
jq -s 'map(select(.metric=="agent_invoke_total")) | group_by(.labels|tostring)
  | map({labels: .[0].labels, delta: (last.value - first.value)})' data/metrics/metrics-$(date +%F).jsonl

# mimo 退化归因：按 model 的守卫中断分布
jq -s 'map(select(.metric=="agent_guard_abort_total")) | group_by(.labels.model)
  | map({model: .[0].labels.model, delta: (last.value - first.value)})' data/metrics/metrics-$(date +%F).jsonl
```

- **实时**：`curl :port/metrics | grep agent_`（进程内存累计值，无需 diff）。
- 前端展示页不在本档 scope。

#### 不做的事（scope 控制）

- 不做前端 metrics 展示页。
- 不改 SSE 事件契约（traceId 不出系统边界）。
- 不做 session 级/用户级聚合指标。
- 不顺手重构 AgentInvoker 重试逻辑（后续插件化 refactor 的事，本 PR 只埋点）。
- 不为 fire-and-forget 回调逐个包裹 trace scope。

### 目标

- T1: agent 域核心指标可通过 `/metrics` 与 `data/metrics/*.jsonl` 消费
- T2: 一次发言链的所有日志可按单一 traceId 串联
- T3: 现有测试全绿，AgentMetrics 缺省注入时不改变任何行为

### 成功标准

- 发一条消息触发双獭对话，`/metrics` 中 `agent_invoke_total{outcome="success"}` ≥ 2 且日志中两跳共享同一 traceId
- 工具调用后 `agent_tool_calls_total`/`agent_tool_duration_ms` 有值
- `npm test` 全量通过

## 验收标准

### 验收场景

| 编号 | 需求 | 复现步骤 | 预期结果 |
|------|------|---------|----------|
| AT-1 | invoke 指标上报 | `curl :3000/metrics \| grep agent_invoke_total` 前后对比，发一条消息触发单獭回复 | `agent_invoke_total{outcome="success"...}` +1；duration/token histogram 有观测值 |
| AT-2 | 退出原因分类正确 | 单测：mock invoke 返回 no-speak 与 user_abort 场景（tests/interface-adapters/agent-invoker-metrics.test.ts，断言 AgentMetrics 调用） | outcome 分别为 `no_speak_retry`/`user_abort`，`agent_retry_total{kind="no_speak"}` +1 |
| AT-3 | 工具级指标 | 正常对话（含工具调用）后 `curl :3000/metrics \| grep agent_tool` | `agent_tool_calls_total`/`agent_tool_duration_ms` 按 tool 维度有值 |
| AT-4 | trace 串联 | 触发双獭链式对话，`grep <traceId> data/logs/otter-buddy.log` | 同链所有 hop 日志含相同 traceId；不同链 traceId 不同 |
| AT-5 | 缺省不破坏 | `npm test`（不注入 AgentMetrics 的既有测试路径） | 全部通过，无异常 |

### 能力测试映射

| 验收场景 | 能力测试文件 |
|---------|-------------|
| AT-1~AT-5 | n/a（纯软件边界内改动，单元/集成测试覆盖，见 `tests/interface-adapters/`、`tests/frameworks/metrics/` 等） |

## 实现细节

### 代码修改

新增：

- `src/usecases/ports/trace-context.ts`：ALS TraceContext（defined-only merge、`traceLogFields`）
- `src/usecases/ports/agent-metrics-port.ts`：AgentMetricsPort 接口 + 封闭枚举 + `toRetryLabel`（分层：interface-adapters/usecases 不 import frameworks）
- `src/frameworks/metrics/agent-metrics.ts`：AgentMetrics 实现（token 差分缓存、reason 归一化、显式 buckets）

埋点：

- `agent-invoker.ts`：`invokeConversation` 拆为 trace wrapper + inner（兜底 traceId + `source=direct`）；`executeAgentInvocation` onEvent 埋工具/SDK 重试/compaction；`classifyAndRoute` 分类后路由前记失败 attempt；`completeAgentInvocation` 记成功 attempt（`outcomeMeta` 显式传入才记，user-abort speaking 收尾不传防双计）；`retryInvokeOnSameMessage` attempt 级计时 + messageId trace
- `dispatch-chain-engine.ts`：`executeChain` 包 trace scope（`source=chain`）+ 链深指标
- `logger.ts`：PinoLogger 四方法合并 `traceLogFields()`（显式 context 优先）

### 逻辑变更

除新增模块外，对现有代码的非埋点性修改（对抗审视后确定的必要接线）：

1. `pi-session-factory._buildInvokeResult`：invoke 结果新增 `modelAlias`（取自 `getModelAliasForLog`）与 `sessionRebuilt`（`createdNew`），随结果流到 AgentInvoker 供 metrics 使用——不改行为，只透传既有事实。
2. `pi-session-factory._executeWithSession` catch 分支：error 附加 `_outputGuardMetadata`（含 firstByteLatencyMs），使 guard abort 路径的首字节样本不随 abort 丢弃。
3. `message-controller.retry` → `invokeConversation` 传递 `manualRetry` 标识，映射 retry label `manual`。
4. `app.ts`：metrics registry 构造提前到 dispatch chain 装配之前（AgentMetrics 需同时注入 chain 与 invoker）。

### 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/ports/trace-context.ts` | 新增 | ALS trace 上下文 |
| `src/usecases/ports/agent-metrics-port.ts` | 新增 | metrics 端口 + 封闭枚举 |
| `src/frameworks/metrics/agent-metrics.ts` | 新增 | AgentMetrics 指标实现 |
| `src/interface-adapters/agent-runtime/agent-invoker.ts` | 修改 | 退出分类/收尾/重试/工具事件埋点 + trace 注入 |
| `src/interface-adapters/agent-runtime/agent-invoke-port.ts` | 修改 | 结果类型补 modelAlias/sessionRebuilt |
| `src/usecases/conversation/dispatch-chain-engine.ts` | 修改 | 链级 traceId 注入 + 链深指标 |
| `src/frameworks/logger.ts` | 修改 | 日志自动富化 trace 字段 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | 结果透传 modelAlias/sessionRebuilt；err 附加 outputGuard 元数据 |
| `src/interface-adapters/http/controllers/message-controller.ts` | 修改 | 手动重试标识传递 |
| `src/app.ts`、`src/bootstrap/platforms.ts` | 修改 | AgentMetrics 实例化与注入 |
| `tests/frameworks/metrics/agent-metrics.test.ts` | 新增 | 指标注册/口径（token 差分/归一化）测试 |
| `tests/usecases/ports/trace-context.test.ts` | 新增 | ALS merge/隔离测试 |
| `tests/frameworks/logger-trace.test.ts` | 新增 | 日志富化测试 |
| `tests/interface-adapters/agent-invoker-metrics.test.ts` | 新增 | 埋点行为测试（outcome/双计防护/trace source） |
| `tests/app/build-app.test.ts` | 修改 | /metrics 装配冒烟断言 |

## 验收结果

### 测试结果

- `npx tsc --noEmit`：0 错误
- `npx eslint .`：0 错误 0 警告
- `npm test`：105 文件 / 1230 用例全过（PR 审视修复后新增 4 个：api_error、user_abort+speaking 收尾、路由抛错重入去重、guard 序列强断言）
- `tests/app/build-app.test.ts`：全栈装配后 `/metrics` 含 `agent_invoke_total`/`agent_tool_calls_total`/`agent_chain_hops`/`agent_first_byte_latency_ms`（AT-1 装配部分）

### 证据判定

| 需求 | 证据状态 | 判定 |
|------|---------|------|
| AT-1 invoke 指标上报（装配+计数） | 单测断言 recordInvoke 全 label；buildApp 冒烟断言 /metrics 注册 | ✅（运行时真实对话验证待上线后按消费闭环命令抽查） |
| AT-2 退出原因分类（no_speak/user_abort/guard/degenerate） | agent-invoker-metrics.test.ts 断言 outcome 序列与 retry 计数、双计防护 | ✅ |
| AT-3 工具级指标 | 单测断言 calls/duration/errors 按 tool 维度 | ✅ |
| AT-4 trace 串联 | trace-context.test.ts（merge/并行隔离）+ logger-trace.test.ts（富化/优先级）；真实链 grep 验证待上线 | ❓（单测证据充分，端到端待运行时） |
| AT-5 缺省不破坏 | 全量 1230 用例含全部既有测试路径通过（未注入 metrics 的构造） | ✅ |

## 对抗审视记录

两轮独立 agent 对抗审视（角度一：技术正确性与实现可行性；角度二：方案价值、scope 与未来演进）。裁决与处置：

### 角度一（技术正确性）

| 编号 | 发现 | 裁决 | 处置 |
|------|------|------|------|
| P0-1 | `tokenUsage` 是 session 累计值，直接做 counter 会按 attempt 全量重记、长会话虚增数量级 | 接受 | 口径改为 otterId 缓存快照差分（attempt 增量），session 重置取全量 |
| P0-2 | 工具错误字段是事件顶层 `isError`，`result.isError` 恒 false（SDK 硬编码） | 接受 | 改用 `e.isError` |
| P1-1 | `tryCompleteSpeaking` 早返回绕过 classify，"success 也在 classifyAndRoute 记录"不成立；err 分支 speaking 收尾丢 token | 接受 | success 埋点移至 `completeAgentInvocation`（同为 user_abort speaking 收尾汇合点，outcome 由调用方传入）；err-speaking 收尾无 token 属既有信息缺口，不补 |
| P1-2 | speak-retry 复用外层 startTime，第二 attempt duration 含第一遍全过程，直方图双计 | 接受 | metrics 单独按 attempt 入口计时（不改既有 duration 返回值行为） |
| P1-3 | 4 个 histogram 无 buckets 定义，默认桶全落 +Inf | 接受 | 显式定义全部 buckets（见指标清单） |
| P1-4 | try 块之前异常绕过埋点，attempt 漏计 | 部分接受 | 罕见路径，记为已知漏计（口径节明示），不为它扩 try 范围改变行为 |
| P1-5 | guard abort 时 firstByteLatencyMs 随 abort 丢弃，恰好丢最关心的超时样本 | 接受 | pi-session-factory catch 分支把 outputGuard 元数据附加到 error 带出 |
| P1-6 | Web 手动重试不经 executeChain，"executeChain 覆盖 Web SSE"表述过宽 | 接受 | 覆盖表修正；手动重试走兜底 trace + retry label 标 manual |
| P2-1 | 构造函数第 10 参数持续恶化（lint 已 disable，不新触发） | 接受现状 | 仍用可选构造参数（与 messageBroadcaster 等既有可选依赖同模式），不引入 setter |
| P2-2 | ALS 传播边界验证：同步 _emit + promise 续体均继承 scope，设计可行 | 确认 | 无需修改；AT-4 留真实验证 |
| P2-3 | PinoLogger ALS 开销可忽略；需定义字段冲突语义 | 接受 | 定义：显式 context 优先 |
| P2-4 | `internal_abort` 不在 reason 归一化枚举 | 接受 | 枚举补入 + 未知值归 `other` |
| P2-5 | toolCallId 缺失需防御（对齐 circuit-breaker 先例） | 接受 | 配对逻辑加防御分支 |
| P2-6 | "rate() 反映成功率"表述不严谨 | 接受 | 改为计数比值表述 |

### 角度二（价值与演进）

| 编号 | 发现 | 裁决 | 处置 |
|------|------|------|------|
| P0-1 | 缺 `model` label，mimo 退化归因（本档第一动机）无法回答；后补 label = 基线作废重来 | 接受 | invoke/duration/token/context/guard_abort/first_byte 全部加 model label |
| P0-2 | SDK 内建 auto-retry（maxRetries=4）在 invoker 层不可见，api_error 前"烧了几次"测不到；事件恰好流经同一 onEvent | 接受 | `agent_retry_total{kind="sdk_auto"}` 埋在 onEvent `auto_retry_start`；kind 枚举分层 |
| P1-1 | 缺 compaction / session 重建 / 链深度三个直连已知痛点的计数器，且都是"顺手就有" | 接受 | 三个指标全部补入（compaction_end 事件、sessionRebuilt 透传、executeChain 链深） |
| P1-2 | 兜底生成 trace 是静默分裂且无断言；入口清单数错（实际 5 个调用方） | 部分接受 | 覆盖表修正为 chain/direct 两类；direct 是 scheduler 常态路径不告警（warn 会刷屏），归因由 source label 承担；手动重试与原链的自动关联不做（记为已知局限） |
| P1-3 | 消费闭环未闭合：无 Prometheus scraper，JSONL 是快照需 diff，文档引用的 rate() 跑不起来 | 接受 | 新增"消费闭环"节：jq diff 示例命令 + curl 实时 + 消费节奏定义 |
| P1-4 | 8/10 指标埋在插件化必拆的私有方法群里，"安全网"钉在要拆的墙上 | 部分接受 | 新增"指标语义契约"节：指标定义与口径锚定为公共承诺，重构不漂移；埋点位置本身允许迁移（outcome 分类信息在 port 边界拿不到，无法上移） |
| P1-5 | 手动重试传 retryCount=1 污染 retry label，稀释自动重试成功率 | 接受 | retry label 三值 `0/auto/manual`，controller 传标识 |
| P2-1 | 缺 entry/source label | 接受（简化版） | source label 两值 chain/direct；更细入口归因推迟 |
| P2-2 | duration 含锁排队与前置开销，语义混杂 | 接受 | 口径节明示语义，不拆分指标 |
| P2-3 | context_tokens 无 label 混两种总体 | 接受 | 加 model + otter_type |
| P2-4 | AT 场景不可自动化 | 接受 | AT 表补具体命令/mock 位置 |
| P2-5 | guard reason 枚举未封闭 | 接受 | 封闭枚举 + other 兜底 |
| P2-6 | 飞书 fire-and-forget 回调日志无 traceId | 接受（不做） | 记入已知局限，不为收尾日志逐个包裹 scope |

### 第三轮（PR diff 审视，实现合入前）

两个独立 agent 对实际 diff 做的审视（角度：计数正确性 / 主流程回归风险）。回归侧结论：**未发现 P0 行为回归**，"只埋点不改行为"逐项比对成立（invokeConversation/executeChain 拆分、SSE 时序、异常传播与 main 一致；ALS 无跨任务污染）。

| 编号 | 发现 | 裁决 | 处置 |
|------|------|------|------|
| P0-1 | `routeByReason` 抛错 → 外层 catch 重入 `classifyAndRoute` → 同一 attempt 双计且误标 `api_error`（路由阶段真实可抛点：queryOtter/settingsRepo/emitEvent 回调） | 接受 | `recordedAttempts` 去重键（`messageId:retryCount`），finally 清理；补端到端测试（路由抛错场景断言恰好两条记录、无虚假 api_error） |
| P1 | err 路径（guard abort 主路径）result 不可达 → model label 全落 `unknown`，击穿 mimo 归因 | 接受（双方独立发现） | pi-session-factory catch 附加 `_modelAlias`；resolveModel 回退链 result → err → unknown；测试断言 err 路径 model 不断 unknown |
| P1 | `recordGuardAbort` 等 metrics 调用裸奔在主流程，破"metrics 失败绝不影响主流程"不变量（若抛错会跳过 guard 自动重试） | 接受 | recordRetrySafe 安全壳 + recordGuardAbort/stream 事件/链深指标全部包 try/catch（范围限定 AgentMetrics 调用点；SchedulerMetrics 裸奔是预存独立 port，不在本档 scope） |
| P1 | 成功路径 `await recordAttempt`（含 DB 读）插在 message.complete SSE 之前，阻塞用户可见完成事件 | 接受 | 改 fire-and-forget（`void`，recordAttempt 内部全捕获不产生游离 rejection） |
| 复核发现 | err 路径 + 消息已 speaking：tryCompleteSpeaking 早返回导致整条 attempt **漏记**（比误标更糟） | 接受 | err 收尾分支按 `classifyExit` 补记 outcome；补 user_abort+speaking 用例 |
| P1 | 测试缝隙：guard 断言过弱（双计漏网）、user_abort+speaking 假验证（未触达分支）、api_error 零覆盖 | 接受 | mock 参数化 guardReason/errModelAlias；guard 序列钉死 `[guard_abort, guard_abort]`+retry label；新增 api_error、路由抛错重入、speaking 收尾用例 |
| P2 | err 路径 token 被下个成功 attempt 吸收；sessionRebuilt 失败路径丢失；chain hops 采样选择偏差；重复构造 AgentMetrics 共享 counter 重置快照；otterId 键控的 1:1 假设 | 接受（记档） | 全部写入口径节"已知漏计"，不改实现 |
| P2 | 重入 classifyAndRoute 自身再抛错会传播给调用方 | 接受（与 main 行为一致，非回归） | 不加第二层 catch（避免吞掉真实基础设施错误），去重键已保证不双计 |

### 第四轮（PR diff 复审，修复代码本身 + 三方对账）

两个独立 agent：一个专攻第三轮修复新增的代码（修复引入新缺陷盲区），一个做文档承诺/实现/验收证据三方对账。对账结论：**无 P0**——15 项指标/口径声明/测试数字/SSE 契约零变更/改动范围全部对上，无占位符残留，AT 判定诚实。修复侧发现：

| 编号 | 发现 | 裁决 | 处置 |
|------|------|------|------|
| P1 | `recordRetrySafe` 不在去重范围：路由抛错重入场景（与第三轮 P0 同源）retry 计数双计；且 `getInternalAbortReason` 是清费式读取、首分类走 `err._guardAbortReason` 时未消费 → 重入可再次分类为 guard_abort | 接受（指标部分） | 重试意图计数移入 `recordFailedAttempt`（分类点），与 attempt 记录共用去重键；删除 routeGuardAbort/handleDegenerateRetry/handleSpeakRetry 三处散落调用。重入导致的**重复重试执行**是 main 预存行为，记档不改 |
| P2 | finally 清理点用模板字符串而非 `attemptKey()`，键格式双写（演进时清理会静默失效） | 接受 | 统一走 `attemptKey()` |
| P2 | 失败路径 `recordFailedAttempt` 仍 await（含 DB 读）阻塞路由，与成功路径不对称 | 接受 | 改同步方法：去重键/guard 计数/重试意图同步完成，DB 读 fire-and-forget（同步前缀保证去重键先于路由加入） |
| P2 | 成功路径测试断言依赖 fire-and-forget 微任务时序（margin 约 2 个微任务跳，结构性但无显式保证） | 接受 | 测试加 `setImmediate` flush；retry 断言从 `toContain` 收紧为 `toEqual`（钉死重入不双计） |
| P2 | err+speaking 补记的 classifyExit 消费清费式 internal reason 后，complete 失败降级路径分类会从 guard_abort 漂移为 api_error | 接受（记档） | outcome 已被去重保护，漂移只影响路由；`_guardAbortReason` 非破坏复制 vs `getInternalAbortReason` 破坏读取的双语义是根因，后续重构 session 重启/守卫时一并处理 |
| P1 | 对账偏差：AT-5 陈旧数字、两处 `tests/unit/` 幻路径、PR body 测试数字未随修复更新、jq 命令缺进程重启归零 caveat | 接受 | 全部修正（本节及 PR body） |
| P2 | compaction reason 非封闭枚举（`unknown` 兜底未文档化）、source label 弱封闭（string + 兜底，无类型约束） | 接受（记档） | 写入方仅两处，风险低；若未来 label 膨胀再收紧 |

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| metrics vs 先建插件化骨架 | metrics 先行 | 插件化是重构，重构需要行为不变性证据；可观测性不依赖插件化（接缝已存在） |
| attempt vs 链级计数 | attempt 粒度 | 重试成功率是核心待测指标；链级可由 traceId 串联推导 |
| token 口径 | otterId 快照差分 | tokenUsage 是 session 累计值（审视 P0 发现），直接累计会虚增数量级 |
| ALS 自建 vs OpenTelemetry | ALS 自建 | 单机自托管场景，OTel 是投机基建 |
| trace 模块位置 | usecases/ports | 双向消费需求 + 分层依赖方向约束 |
| 高基数字段 | 只入日志不入 label | prom-client label 基数失控会打爆 registry 与 flush 文件 |
| 指标语义 vs 埋点位置 | 语义锚定为契约 | 埋点在插件化必拆的私有方法内，语义必须独立于实现存活 |
