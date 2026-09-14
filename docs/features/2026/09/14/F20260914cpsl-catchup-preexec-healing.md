---
id: F20260914cpsl
title: catch-up 前置阶段炸点落 healing：claim 后 execution 建立前的静默死亡现形
summary: 定时任务 catch-up 在 claim 成功后、execution 行建立前的失败完全静默（外层 try 无 catch，异常直抛调用方只 logger.error）——2026-09-14 生产现场 4 任务连炸零痕迹（搭档体感「对话几天没跑」但系统无告警）。修复：triggerTask 补前置窗口 catch，炸点落 medium healing event 后 rethrow（best-effort）。#912 修 FK 后此路径不再是活跃炸点，但结构性盲区（任何未来 claim 后 insert 前抛错场景）由本特性兜底。
change_type: fix
capability_test: "n/a: 纯失败路径可观测性补强，验证走 tests/usecases/scheduler/scheduler-service.test.ts #913 describe（2 用例：前置炸点落账 + claim 拒绝不落）"
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
tags: [scheduler, healing, observability, catch-up, silent-failure]
modules: [src/usecases/scheduler/scheduler-service.ts, tests/usecases/scheduler/scheduler-service.test.ts]
---

## 背景

#913（F20260914fkx1 排查衍生发现）：catch-up 触发链在 `claimAndValidateTask` 成功后、`createExecution` 落行前的异常**完全静默**：

- 无 execution 行（INSERT 本身失败）
- 无 healing event——#849 的单次失败落账只覆盖 execution 建立后的 `handleExecutionFailure` 路径
- 无 consecutiveFailures 累计（失败计数在 claim 成功后的 execution 生命周期里）
- 调用方（tick :291）只 logger.error 一行

现场：4 任务 catch-up 全部炸在 createExecution 的 FK 残留（`no such table: main.messages`，log 887782），零痕迹。#912 已修 FK 主因，但「前置阶段失败零痕迹」的结构性盲区仍在。

## 方案设计

`triggerTask` 外层 try 原本只有 finally 没有 catch。补一个 catch + 窗口标记：

1. **`executionEstablished` 标记**：createExecution 成功后置 true
2. **外层 catch**：`!executionEstablished && status !== 'skipped'` 时（即 claim 成功后、execution 建立前的炸点）调 `recordPreExecutionFailureHealing` 落 medium healing（errorType=other，context 含 taskId + stage='pre-execution' + triggerError 截断摘要），然后 rethrow
3. **`recordPreExecutionFailureHealing`**：与 #849 的 `recordSingleFailureHealing` 同语义但不依赖 executionId（前置失败时 execution 行不存在）。best-effort：落账失败只 warn 不阻断

**Why 不走 handleTaskExecutionFailure**：那条链路第一步是 updateExecutionStatus——前置失败时 execution 行不存在，update 只会二次失败。
**Why 不计入 consecutiveFailures**：失败计数器挂在 execution 生命周期上；前置炸点无 execution 可挂，且 FK 类 DB 故障连续计数会误触熔断（那是任务逻辑失败的保护，不是 DB 故障的保护——DB 故障该走 healing/人工）。
**claim 被拒不落账**：running execution 存在的 claim 拒绝是正常并发跳过（skipped），非失败。

## 取舍

- severity=medium（非 high）：对齐 #849 单次失败口径；前置炸点通常伴随 DB 级故障（如 FK 残留），healing 分析任务会发现
- 不在本层做重试：catch-up 的重试语义归 tick 调度（下轮 tick 自然重试 claim——claim 已被回滚性跳过的场景除外），本层只负责「可见性」

## 验证

- `tests/usecases/scheduler/scheduler-service.test.ts` 60/60（58 旧 + 2 新）
  - 新1：createExecution 抛 SqliteError（#912 现场同构）→ healing 落 1+ 条 pre-execution 事件（medium/other/taskId/stage/triggerError 断言）
  - 新2：claim 被拒（running execution 存在）→ 零 pre-execution 事件（skipped 不落账）
- 全量 2874/2874 + tsc 0 错

## 遗留

- tick 调用的 logger.error（:291-293）保留——healing 与日志双通道，不互斥
