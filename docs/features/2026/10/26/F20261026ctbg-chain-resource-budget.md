---
id: F20261026ctbg
title: 发言链资源预算与可解释熔断
summary: "以链内真实 token 增量替代固定 100 跳主约束，重复回路仅作风险观测；补齐熔断原因、深度、token、pendingTargets 的日志、指标、healing 与对话提示。"
change_type: fix
capability_test: "n/a: 确定性链调度、配置与可观测性变更，无 prompt/LLM 行为语义改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-26T10:00:51+08:00
causal_links:
  from: [F20260724regd, F20260907grdr, F20260923icus]
tags: [dispatch-chain, token-budget, observability, circuit-breaker]
modules: [src/usecases/conversation/dispatch-chain-engine.ts, src/frameworks/config-service.ts, src/frameworks/metrics/agent-metrics.ts]
---

# 发言链资源预算与可解释熔断

## 排查预注册

- 预期：固定 `maxDepth=100` 是 #1637 的截断点；若日志同时出现 `depth=100`、`pendingTargets` 与交还用户，则预期成立。
- 反例：目标獭已收到 invoke 但没有发言、或其他 guard 终链，则放弃该预期。
- 实际：日志 `otter-buddy.log:2276137` 记录 `depth=100`、目标 `7a524b68…`；同 trace `t_b8e6d7231d08` 的前一 invoke 已完成并 yield 该目标，符合预期。

## 背景

搭档原话（意图锚）：

> 「1.监控一定要加，避免下次你找了半天才找到根源」
> 「不应该用一个固定的 数字 来当作海獭间协作的上线……必须定义好什么叫做『最坏的情况』。这个情况肯定不是 海獭间协作100轮。」
> 「按你推荐的来做」

此前根因定位：固定 100 跳截断了仍有 `pendingTargets` 的流水线，而不是目标獭收到派工后沉默。已确认方向是方案 C：token 主约束、回路检测、跳数软上限及可解释熔断。

## 目标

- T1：长而持续推进的协作不因「第 100 跳」这个数字本身被截断。
- T2：单链资源耗尽、失去进展证据的回路有有限边界；任何熔断都说明原因及未派发目标。
- T3：复用 `AgentTurnResult.tokenUsage`，不在链内累加历史 session 总账。
- T4：配置、日志、Prometheus、healing、对话 system entry 五处口径一致。

## 非目标

- 不修改 LLM 的 yield 决策、提示词或既有 self-yield 梯度护栏。
- 不把「A→B→A」或固定拓扑重复本身视为病态；审视返修、章节流水线可合法重复。
- 不做跨链/跨日成本配额，不引入 DB schema、后台任务或自动恢复派发。
- 不声称 token 是各模型完全一致的美元成本；本特性约束的是 token 资源量。

## 未决问题

无。阈值采用下方实证初始值，后续根据新指标复核，不把初始值表述为永久真理。

## 实证与阈值

生产 DB 以 `sqlite3 -readonly` 只读抽样（2026-10-26）：近 7 天 1,522 条有 usage 的 invoke，按 otter 排序后逐分量差分，snapshot 回退时取当前值；四分量为 input/output/cacheRead/cacheWrite，历史 cache 列均为空。

- 每次调用 token 增量估算：P50=94,592；P90=430,165；P95=730,013；P99=1,790,951；均值 206,524。
- `agent_chain_hops` 累计桶：96 条链中 94 条不超过 13 跳，2 条超过 50 跳；旧计数只证明发生过触顶，不提供本次完整链 token 分布。
- 初始主预算 `maxChainTokens=10,000,000`：约 13.7 个 P95 调用，明显小于原方案中随手写的 500K，避免对当前真实使用形态过敏；置信度中（cache 历史缺失、并非逐链重放）。
- `chainDepthSoftLimit=100`：达到即 warn + healing，不阻断；2,000 跳仅作为 usage 缺失/异常调度下的最终逃生边界。它不是「协作达到某轮就错」的语义判定，而是防进程无限占用。
- 重复回路进入观测窗口后仍只消耗同一主预算，并记录 warning；只有无进展证据（重复回路且未获得可计量 token 增量）才计入停滞，停滞达到 20 hop 熔断。正常的 A→B→A 不触发。

## 机制识别与预算四问

检查点：☑ 新配置字段；☑ 配置化熔断原因；☐ 新生命周期；☐ 后台任务；☐ 新消息格式（复用 system entry）；☐ 持久化 schema；☐ 被记住的新决策分支（仅运行时）；☑ tokenUsage 新消费路径。按净新增机制走重对抗门。

1. **谁需要它**：搭档需要长任务不被固定数字截断、熔断时知道谁被跳过；大獭需要凭事件定位根因而非翻数小时日志。
2. **失败后果**：现状会静默破坏任务交付；取消一切边界则失控链可耗尽 token/请求时间。本机制失败的具体风险是错误计量导致早停或晚停，故熔断与计量异常都显式可见。
3. **后续机制**：快照回退、缺失 usage、并行 fan-out 可能失真；由逐分量差分、rejected 不计账、fallback 上限与监控处置，不再叠加隐式修复机制。
4. **退役条件**：若底层提供逐 attempt 的权威 usage + 链级成本 ledger，本模块的链内差分器应被该权威增量替代；若软告警长期无诊断价值可删除，最终安全边界不能仅因「没触发」删除。本机制是长期安全承诺。

## 方案设计

### 核心抽象

- `TokenUsage` 沿用 `{input, output, cacheRead?, cacheWrite?}`。
- `AgentTurnResult.tokenUsage` 保留 session 累计快照语义，新增 `tokenUsageDelta` 表示本次逻辑 invoke 的真实增量；`InvokeFnResult` 透传后者，绝不逐跳相加累计快照。
- `token-usage.ts` 提供四分量纯函数：session 前后差分、同 invoke 各 attempt/递归重启增量合并、预算总量计算。快照下降表示新会话/重置，取当前值，绝不产生负消耗。
- `ChainResourceBudget` 是单链临时对象，不引入 DB 生命周期。收到每个 fulfilled target 的 `tokenUsageDelta`；rejected target 不计入。
- 回路记录真实行级 tsp 的有向交棒边；原始窗口最多 16 条，用于发现最多 8 边的重复后缀；另保留 activeCycle 与相位，避免截窗破坏正在运行的循环。拓扑重复只观测。
- `ChainStop`：`{reason:'token_budget'|'stalled_cycle'|'hard_depth', depth, totalTokens, pendingTargets, detail?, healingEventId?, healingStatus?:'unavailable'|'write_failed'}`；`callbacks.onChainStopped(stop)` 替代只知 depth 的回调。

### 循环顺序

1. 每 hop 前：若深度达到软上限，告警但继续；若 token 已超预算，停止；若达到 2,000 最终深度，停止。
2. 执行 hop，聚合 fulfilled 调用的 usage 差分；rejected 不推进 token 账本。
3. 根据真实行级 tsp 计算 nextTargets，记录 from→to 的拓扑窗口。
4. 只有「重复回路 + usage 存在 + 本 hop 真实 token 增量为 0」才推进停滞计数；有增量由主预算约束。telemetry 缺失不冒充语义停滞证据，仅由 hard depth 逃生边界保护。
5. 停止时统一记录结构化日志、指标、healing，并调用 controller 生成带原因/深度/token/pendingTargets 的 system entry；目标獭不伪造「已执行」记录。

### 接口与配置

- `circuitBreaker.maxChainTokens` 默认 10,000,000。
- `circuitBreaker.chainDepthSoftLimit` 默认 100。
- `circuitBreaker.maxChainDepth` 默认改为 2,000，保留原字段名以避免配置迁移，但语义明确降为最终逃生边界。
- `circuitBreaker.stalledCycleHopLimit` 默认 20；最大周期 8 条边，原始窗口最多 16 条，另存 activeCycle 相位，不新增配置面。
- 新指标：`agent_chain_stopped_total{reason}`、`agent_chain_token_usage`（histogram）、`agent_chain_soft_depth_total`；保留旧 `agent_chain_depth_exceeded_total` 表示 hard_depth，避免旧告警断义。
- healing：复用 `circuit_break`，context 以 `chainStop` 区分链停止；medium 记录软告警/停滞，high 记录 token/hard 终链并 enqueue 既有 healingAlertRegistry。

### 顺带修复同链路缺陷

`buildInvokeResult` 已构造四分量快照，但 `buildResult` 当前只返回 input/output（`circuit-breaker-helpers.ts:359-361`），导致 DB cache 列全空。此次预算需要完整 token 口径，修复该既有透传遗漏，并加四分量回归测试。

## 影响范围

- DispatchChainEngine、AgentTurnResult 消费、配置装配、MessageController 停止通知、AgentMetrics。
- scheduler / invoke-controller 等复用链引擎路径自动受新约束；无独立 DB 状态。
- 既有 `maxChainDepth` 显式小值（测试配置=4）仍作为最终上限，行为不变；生产默认由 100 提升为 2,000，主约束换为 token。

## 风险与约束

- 基线在 Pi session 每次 SDK invoke 前捕获，不把本链开始前的 session 旧账算入新链；同 invoke 内自动重试和熔断自重启逐段累加，不取末次覆盖前段。
- `AgentInvoker` 是 usage 聚合的统一返回边界，避免嵌套 SDK/turn 多层重复计账；既有 `tokenUsage` 快照仍按原口径写 invoke 行。
- fan-out 先对所有 fulfilled target 记账，再处理路由 abort，已完成并发目标不因提前终链漏计；任一 fulfilled target 缺 telemetry 时，本 hop 不得推进停滞。rejected target 不计账，也不纳入 telemetry 完整性。同獭同 hop 的去重仍由现有 nextTargets Set 保持。
- 已消耗后 SDK 抛错，由异常携带 `_tokenUsageDelta`；orchestrator 将 rejected attempt 与后续重试各合并一次。
- 新增链资源阈值在配置加载时必须为有限正整数，非法值 fail-closed；不允许 0 被资源层静默放大成默认值。
- healing 写入成功才提供 event ID；写入失败与未配置分别提示，不伪报台账状态。
- 没有 usage 时无法用拓扑判断业务进展；不将其伪报为停滞，最终由 hard depth 兜底。显式零增量回路不代表零模型活动，只表示所取 usage 窗口没有可计量资源进展。

## 不兼容更新

- [Incompatible] 默认第 100 跳不再硬停；运维若依赖 100 作为唯一成本防线，须改看 token 预算/停止指标。显式配置 `maxChainDepth` 的行为不变。
- 旧 `onDepthExceeded` 回调改为 `onChainStopped`，内部调用点同步更新；无外部 API 合约变化。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 固定 100 硬停 | token 主预算 + 软告警 + 逃生上限 | 只把 100 改 200 | 单纯放大数字仍会误杀，且未约束成本 |
| token 口径 | SDK 调用前后基线差分，turn 层累 attempt | 首见快照 / 直接 sum 每个 result | 前者误纳链前旧账，后者重复记累计值 |
| 拓扑重复 | 观测；仅与无计量进展联合停滞判定 | visited 即停 / 重复边即停 | 合法返修和章节流都天然有环 |
| 缺失 usage | 保留最终 hard-depth + 可见停滞信息 | 把缺失当 0 无限跑 / 立即停 | 前者失控，后者误伤旧 adapter |
| cache 四分量 | 修复既有透传遗漏后纳入 | 继续只算 input/output | 预算需要真实 token 资源口径 |
| 历史 20→100 的治理 | 回应同一误杀问题，但不再用另一个相似数字作主语义 | 继续调固定跳数 | 新方案直接约束资源与无进展，而非流水线长度 |

独立方案重对抗：已覆盖必要性、失败后果、后续机制、退役条件与阈值实证，结论为治本方向；代码阶段的独立对抗审视与 delta 复核另按 PR 流程执行。

## 验证（验收断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 原 bug | 在修复前运行新增的 >100 持续推进链用例 | 第 100 跳后 pending target 被截断；修复后在 token 未超限时完成 |
| 单次基线 | 同一 session 连续 invoke 前后快照 | 每次只计本次差分，旧历史不重复计 |
| 快照重置 | 同獭快照下降 | 取新快照为增量，不产生负数/丢账 |
| 主预算 | 增量累计达到 maxChainTokens 后仍有目标 | 不再 invoke，stop.reason=token_budget，pendingTargets 完整 |
| 正常返修 | A→B→A→B 少量重复且有 usage | 不因拓扑本身停止 |
| 无进展回路 | 重复拓扑、显式零增量达到阈值 | reason=stalled_cycle，带深度/目标/healing |
| usage 缺失 | 重复回路不返回 tokenUsageDelta | 不伪报停滞；hard depth 保留 |
| 自动重试 | 同 invoke 两次 attempt 增量 50+20 | 返回 70，不只保留末次 20 |
| 熔断自重启 | 两段 invoke 增量 15+30 | 返回 45，不丢旧 session 消耗 |
| 软深度 | 达到 100 仍有进展和预算 | 记录 warning/healing，继续执行 |
| 逃生边界 | 达到配置 maxChainDepth | reason=hard_depth；旧指标仍计数 |
| 通知 | MessageController 收到 stop | system entry 含原因、深度、token、pendingTargets |
| 配置 | 读取默认值及 YAML 覆盖 | 新默认值与覆盖值符合上表 |
| 四分量 | buildResult 输入 cacheRead/cacheWrite | 返回不丢字段，链预算可消费 |

## 负面向验收

本次有意改变旧契约：100 跳硬停退役；不绕过 self-yield、安全词、tool guard、scheduler watchdog 等既有保护。不会伪造 pending 目标已运行，也不自动重试已停止链。

## 最简实现检查

复用 `AgentTurnResult` 返回边界、`healingRepo`、`healingAlertRegistry` 和 metrics registry；不新增 DB、后台任务、框架或持久化账本。token 纯函数与资源守卫独立成小模块，避免继续扩大既有超长 controller/engine；单链状态由链创建并随 settle 回收。

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/usecases/conversation/dispatch-chain-engine.ts` | 修改 | 每跳增量/转移边接入、软/硬边界、停止上下文 |
| `src/usecases/conversation/token-usage.ts` / `chain-resource-budget.ts` | 新增 | 纯计量函数与单链临时预算 |
| `src/usecases/ports/sdk-invoke-port.ts` / `agent-turn-port.ts` | 修改 | 单次增量契约 |
| `src/frameworks/agent/pi-session-factory.ts` | 修改 | SDK 执行前快照基线 |
| `src/usecases/conversation/agent-turn-orchestrator/**` / `agent-invoker.ts` | 修改 | attempt、重试、自重启增量合并 |
| `src/interface-adapters/http/controllers/message-controller.ts` | 修改 | 可解释 system entry |
| `src/frameworks/config-service.ts` | 修改 | 配置与默认值 |
| `src/bootstrap/platforms.ts` | 修改 | 配置装配 |
| `src/frameworks/agent/circuit-breaker-helpers.ts` | 修改 | 四分量透传遗漏修复 |
| `src/usecases/ports/agent-metrics-port.ts` / `src/frameworks/metrics/agent-metrics.ts` | 修改 | 停止原因、token、软深度指标 |
| `config/config.yaml.example` | 修改 | 运维口径 |
| `tests/**` | 修改/新增 | 上述行为验收 |
| 本文档 | 新增 | 方案、实证、决策与验证档案 |
