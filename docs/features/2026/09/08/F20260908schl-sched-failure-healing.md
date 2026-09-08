---
id: F20260908schl
title: "定时任务单次执行失败落 healing 台账：消灭「未达 3 次熔断阈值」盲区（closes #754）"
summary: "9/2 09:00 每日健康检查失败（session lock timeout）未落 healing 台账，根因悬置 6 天——#516 只在连续 3 次失败停跑时才写 healing event，单次失败是盲区。修复：handleExecutionFailure 单次失败即落 healing event（medium，含 executionId + 完整错误文本），熔断停跑的 high 事件保留不变。定时任务按天/周低频触发，等 3 次失败可能 3 天，与「healing 是问题发现第一入口」定位相悖。"
change_type: fix
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 303b94d4-b3ad-4de4-9ee4-2b54da95f9a2
tags: [scheduler, healing, observability, daily-review]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
created_at: 2026-09-08
---

# 定时任务单次执行失败落 healing 台账（closes #754）

## 背景

Issue #754：9/2 09:00 每日对话健康检查执行失败，**未落 healing 台账**——本批跨 open/resolved 池检索均无对应事件，根因悬置 6 天。

## 根因核实（本特性新增，issue 原文未定位到代码行）

真库 SQL 复查 9/2 现场：execution `992c033f`（09:00 健康检查）status=failed，errorMessage 完整在库（`Lock acquire timeout for key: session:87f172c6...`）——**「错误截断」只是 UI 展示层现象，数据层完整**。

代码链路：`handleExecutionFailure`（scheduler-service.ts:959）只在 `consecutiveFailures >= 3`（熔断停跑）时才走 `notifyTaskErrored` → 写 healing event（#516）。9/2 是单次失败（前一天失败后中间有成功执行），**未达 3 次阈值 → 台账零记录**。

设计冲突：定时任务按天/周低频触发，等 3 次失败可能 3 天——与「healing 是问题发现第一入口」的定位相悖。

## 修复

`handleExecutionFailure` 单次失败即落 healing event（best-effort，不阻断失败处理主路径）：

- errorType `'performance'`（复用 #516 既有类型，healing-error-type 枚举加新值影响面大，收益低）
- severity `'medium'`（单次失败）vs `'high'`（熔断停跑，#516 保留不变）
- context 含 `taskId + executionId + executionError` 完整文本

## 测试

`scheduler-service.test.ts` #516 用例更新：3 次失败共落 4 条事件（3 medium 单次 + 1 high 熔断），断言 medium 事件含 executionId 与完整错误文本。57/57 通过。

## 验证

- scheduler-service 测试 57/57 全绿，tsc 0 error
- 最简检查：复用 healingRepo 既有注入（#516 同路径），零新依赖
- issue 方案 3（观测的观测：失败但无 healing 事件 → 告警）未做——本修复后「失败必落账」语义成立，观测缺口已闭合，自检举报警属过度建设

## Discovered Issues

无。
