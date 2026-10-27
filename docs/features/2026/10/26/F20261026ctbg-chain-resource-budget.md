---
id: F20261026ctbg
title: 发言链可观测与明确停止边界
summary: "移除按 token、总深度或回路形状自动终止正常协作的机制；保留真实 token 增量与有界链观测，并修复 self-yield 护栏被透明条目挤盲的问题。"
change_type: fix
capability_test: "n/a: 确定性链调度、数据库查询与可观测性变更，无 prompt/LLM 行为语义改动"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-26T10:00:51+08:00
causal_links:
  from: [F20260724regd, F20260907grdr, F20260923icus]
tags: [dispatch-chain, token-usage, observability, self-yield]
modules: [src/usecases/conversation/dispatch-chain-engine.ts, src/frameworks/db/conversation/sqlite-entry-repository.ts, src/frameworks/metrics/agent-metrics.ts]
---

# 发言链可观测与明确停止边界

## 排查预注册

- 预期：固定 `maxDepth=100` 是 #1637 的截断点；若日志同时出现 `depth=100`、`pendingTargets` 与交还用户，则预期成立。
- 反例：目标獭已收到 invoke 但没有发言、或其他 guard 终链，则放弃该预期。
- 实际：日志 `otter-buddy.log:2276137` 记录 `depth=100`、目标 `7a524b68…`；同 trace `t_b8e6d7231d08` 的前一 invoke 已完成并 yield 该目标，预期成立。

## 背景与方案纠偏

搭档最初要求：监控必须能解释根因；不能用固定数字定义协作上限，约束必须针对可定义的坏状态。初版 PR #1639 曾采用“10M token 主约束 + 100 跳软告警 + 2,000 跳硬边界 + 回路零增量停滞停止”。该方向在初版实现前获得过方案授权，但其完整后果没有被充分展示。

搭档随后指出：正常协作消耗 10M 也会停止，并要求从第一性原理讨论，而不是由搭档补方案。大獭与 GLM 经三轮反方讨论后，撤回初版的资源停止策略。搭档最后确认“ok。那这个来做”，授权按下列原则实现，不是合入授权。

核心结论：链调度器知道路由与计量事实，不知道任务是否值得继续。token、总深度、拓扑环是资源或结构形状，不是任务异常的充分证据。计量器异常时应降级该信号，而不是牺牲业务链。

## 目标

- T1：正常协作不因 token 总量、总跳数或 A→B→A 拓扑被自动终止。
- T2：每次逻辑 invoke 的真实 token 增量继续准确透传；链结束留下深度、已知消耗、计量完整性和 pendingTargets 证据。
- T3：保留明确的用户停止、真实外部错误和既有 #530 self-yield 行为护栏；不把 #530 扩展成通用循环判定。
- T4：#530 不再被大量透明 speak/invoke 或不相关 yield 挤出证据窗口。

## 非目标

- 不声称能识别“有真实输出但语义原地重复”的任务死循环；它与正常返修在调度器信息集内不可可靠区分。
- 不设置隐藏的默认账户/任务预算，不做跨链、跨日成本配额，不引入 DB schema 或后台任务。
- 不把 telemetry 缺失/矛盾当作停止任务的理由，不用更大的固定窗口掩盖 #530 的查询问题。
- 不改变配额、模型/API 故障、用户停止等既有边界的职责。

## 机制识别与修改类别

检查点：☐ 新配置；☐ 新状态生命周期；☐ 后台任务；☐ 新消息格式；☐ 新持久化 schema；☐ 被记住的新决策分支；☑ 新增 SQLite 专用读取路径。

修改类别为 `deletion`：删除 `ChainResourceBudget` 及 token/depth/stalled 停止路径、对应配置和指标。新增读取路径只是 #530 既有计数语义的数据源修正，不新增停止条件、运行时生命周期或持久化状态，因此不是净新增机制。token 计量复用本 PR 已验证的 delta 资产，不再承担预算职责。

## 最终契约

### 谁可以停止，谁只负责说明

| 事实/机制 | 职责与处置 |
|---|---|
| 用户明确停止 | 按既有停止通道处理 |
| 配额耗尽、模型/API/进程错误 | 按既有错误、重试、降级与告警路径处理；不伪装成“链太长” |
| #530 连续 self-yield | 保留既有具体行为策略：第 3 次 steer、第 5 次 abort + healing；它是行为约束，不宣称为客观任务故障证明 |
| token 总量 | 只计量，不参与链停止 |
| 总深度 | 只计量，不参与链停止 |
| A→B→A、零 delta、telemetry 缺失 | 只可作诊断上下文，均不触发链停止 |
| 语义任务价值/语义死循环 | 调度器不替任务判死；承认不可可靠判定 |

### 有界链观测

`DispatchChainEngine` 只保留标量聚合：深度、已知四分量 token 总量、是否出现 fulfilled 调用的增量缺失，以及具体 guard 停止的 pendingTargets。不保留逐跳用量数组、回路窗口或无限增长的诊断历史。既有 `chainSourceMessageIds` 保持原语义，不属于本次新增观测账本。

链结束时输出 `发言链观测汇总` 日志，并记录：
- `agent_chain_hops`：每链 hop 分布；
- `agent_chain_token_usage`：已知 token 增量之和，明确不承诺为完整美元成本；
- `agent_chain_telemetry_gap_total`：出现过计量缺口的链数，每链最多一次；
- 计量缺口另有一条 warn，明确“只观测、不停止”，携带深度、已知 token 和 pendingTargets。

旧 `agent_chain_stopped_total`、`agent_chain_depth_exceeded_total`、`agent_chain_soft_depth_total` 随其对应机制删除。指标写入失败不影响路由。非 MessageController 入口不伪称生成对话 system entry；本次也不新增资源停止 system entry。

### token 增量仍然保留的资产

- `tokenUsage` 保持 session 累计快照；`tokenUsageDelta` 表示本次逻辑 invoke 的真实增量，二者不混用。
- SDK 调用前后按 input/output/cacheRead/cacheWrite 差分；快照回落按新会话处理；异常 attempt、自动重试、递归自重启与 fan-out 继续合并。
- 路由 abort 前仍先收集所有 fulfilled 结果；缺失不是显式零。链侧只求和，不以零值、缺失或回路推导停滞。
- 顺带保留 `buildResult` 的 cacheRead/cacheWrite 四分量透传修复。

### #530 计数窗口修复

生产 SQLite 增加专用读取：以当前 invoke 最早 entry 为时间边界，只读取之前的 user 和与该獭相关的 yield 条目，最多取 `abort 阈值 - 1 = 4` 条决定性记录。speak/invoke_start/invoke_end 和不相关 yield 不再挤占窗口。找到 user/外部介入或四条 self-yield 即足够，既不需要放大 100 条窗口，也不需要无限分页。

该查询只是读取投影，不修改表结构。通用 `EntryRepository` 增加这一用途明确的查询；引擎对未实现专用查询的旧测试/嵌入适配器保留原有降级读取，生产 SQLite 必须走专用路径。护栏计数异常仍按既有 fail-open 处理，不借通用链上限补偿。

## 不兼容更新

- [Incompatible] `token_budget`、`hard_depth`、`stalled_cycle` 不再存在；本地 `maxChainTokens`、`chainDepthSoftLimit`、`stalledCycleHopLimit`、`maxChainDepth` 不再决定链的存活，可从配置删除。
- `onChainStopped` / `ChainStop` 及其 MessageController 资源停止提示删除。#530 自身日志、healing 和终链行为保留。
- 取消这些保护是有意接受其原问题边界：语义失控链可能持续到人工停止或真实外部错误；不再声称通用阈值能识别它。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 资源硬停 | 删除 token/depth/stalled 三类自动停止 | 调大数字、只改叫 assert | 数字和名称都不能证明任务异常；观测故障不应停业务 |
| 观测 | 标量聚合 + 每链最多一次计量缺口 warn/metric | 每跳 healing、无限诊断历史 | 避免告警风暴与诊断账本自身失控 |
| #530 窗口 | 查询决定性 user/yield，最多 4 条 | 100→1000、全表扫描 | 透明条目本就不参与计数，过滤后证据不被挤掉 |
| 计量 | 保留 delta 并只观测 | 删除全部计量或继续用于预算 | 准确计量对定位有价值，但无需拥有停止权 |
| 语义失控 | 坦诚不可判定，由明确外部边界处理 | 用拓扑/token 猜 | 正常返修与失控在该信息集内同构 |

## 验证（验收断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 原 #1637 | 在旧基线运行持续推进 101 跳行为用例 | 旧实现停在 100；本实现完成 101 |
| 深度不是停止条件 | 合法链在明确第 2,001 跳收尾，并传旧小深度配置 | 全部执行，无资源停止回调/提示 |
| token 不是停止条件 | 合法链已知增量累计超过 10M，并传旧小 token 配置 | 全部执行，指标只记录真实总量 |
| 回路/零 delta | A↔B 重复且 delta=0，在有限目标处收尾 | 不触发 stalled_cycle，完整执行 |
| 计量缺口 | 部分或全部 fulfilled 调用缺 delta | 每链一个 gap metric + 一条 warn；链继续 |
| fan-out/异常 | 重试、晚到 abort、fan-out、递归重启既有回归 | 增量不漏计、不双计，四分量不丢 |
| #530 透明噪声 | 四个旧 self-yield 后插入 >100 条透明/不相关条目 | 当前第 5 次仍按 #530 abort，证据不被挤掉 |
| #530 正常介入 | user 或外部介入后重新计数 | 既有梯度语义不变 |
| 观测失败 | metrics/healing 不可用 | 不影响正常路由；不伪造 system entry |
| 配置 | 旧资源阈值仍留在本地 YAML | 不再被链引擎读取为停止条件 |

## 负面向验收

本次有意破坏旧契约：通用资源停止退役，因此失去“烧到某数值自动停”的表面确定性；接受语义失控需要人工或外部错误边界的风险。不得绕过 #530、安全词、tool guard、scheduler watchdog，也不得伪造 pending 目标已执行。监控缺口只降低可观测性，不改变业务链控制流。

## 最简实现检查

删除预算类、阈值配置、软告警和停止通知，不为它们再造替代抽象。保留一个小 token 纯函数模块和现有返回边界；#530 只新增一个 SQLite 查询投影。无新框架、DB 表、后台任务或通用任务状态机。

## 改动范围

- `dispatch-chain-engine.ts`：删除资源预算与回路判定，聚合链观测，保留 guard 停止上下文；gap warn/metric 在检出点即时发（每链一次，context 锚定缺口 hop 位置）。附件/FTS 助手拆至 `entry-attachment-helpers.ts`（薄委托，主文件回到 450 行 lint 上限内）。
- `chain-resource-budget.ts` 与其测试：删除；由链观测行为测试（`chain-observability.test.ts`）替代。
- `token-usage.ts`、SDK/orchestrator/invoker 返回路径：保留真实增量资产。
- `entry-repository.ts` / `sqlite-entry-repository.ts`：#530 专用决定性记录查询。
- `config-service.ts`、bootstrap、配置样例：移除资源阈值装配。
- metrics、MessageController、scheduler 注释与相关测试：同步删除旧停止语义，保留准确观测。

### 实现过程中的测试形态收敛（F20261026ctbg 补录）

旧 self-yield/深度测试里大量用例是「静态 mock + 无限自续」形态：invoke 行 tsp 恒指向自己且消息表 seed 固定，旧代码靠 `maxChainDepth` 硬停兑住。硬停退役后这类用例在生产语义下会永久挂起（真实世界消息表逐 hop 增长、计数会爬到 abort@5；静态 seed 冻结计数）。收敛方式：`selfTspOnceThenEnd` helper 让首跳返回 self-tsp（护栏计数在首 hop 即被验证）后自然收尾；计数爬升到 abort 的行为由梯度响应组（seed 逐次增长）覆盖。「深度触顶」HTTP 测试改写为合法互传自然收尾。这不是测试妥协——无限等待从来不是合法验收手段，旧测试靠硬停截断才没有挂起，本身就是在测已删除的行为。
