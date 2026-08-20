---
id: F20260819schd
title: 修复 Scheduler 三个 pre-existing bug
summary: 修复 SchedulerService 中三个 bug：resetConsecutiveFailures 失败覆写 completed execution（#251）、cron 24h 截断提前触发任务（#247）、once 重试机制不一致（#246）。
change_type: bugfix
status: locked
created_in_conversation: bbcfaa33-f036-4493-94de-3faf1c6df6cf
modules:
  - src/usecases/scheduler/scheduler-service.ts
tags:
  - scheduler
  - bugfix
from:
  - F20260819schd
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
---

# 修复 Scheduler 三个 pre-existing bug

## 背景

PR #248 第三轮对抗检视和静态代码检视发现三个 scheduler 模块的 pre-existing bug。

## 问题与修复

### #251: handleExecutionFailure 覆写已 completed 的 execution record

**问题**：`resetConsecutiveFailures` 在 `completeExecution` 之后调用，如果抛 DB 错（如 SQLite locked），会走 catch → `handleExecutionFailure` → 将已 completed 的 execution record 覆写为 failed。

**修复**：吞掉 `resetConsecutiveFailures` 的错误（log warning + 不 throw），不影响成功语义。

### #247: cron 任务 24h 截断会提前真实触发任务

**问题**：delay > 24h 时 actualDelay=24h，但回调里直接 `triggerTask`（真实执行），导致月级/周级 cron 任务在中间每 24h 都被真实触发一次。

**修复**：24h 截断后只重新调度（`scheduleNext`），不触发任务。

### #246: once 任务重试机制不一致

**问题**：设计意图 3 次重试，实际 2 次有效 + 1 次被 status 检查 abort。`handleExecutionFailure` 的 consecutiveFailures 追踪和 `triggerOnceWithRetry` 的重试逻辑冲突。

**修复**：once 任务重试时跳过 `handleExecutionFailure` 的 consecutiveFailures 追踪，由 `triggerOnceWithRetry` 独立控制重试/error 语义。

## 变更文件

- `src/usecases/scheduler/scheduler-service.ts`：三个 bug 修复
- `tests/usecases/scheduler/scheduler-service.test.ts`：新增 3 个专项测试

## 测试

- 新增 #247 测试：24h 截断后只重新调度不触发
- 新增 #246 测试：once 重试全部失败后正确标记 error
- 新增 #251 测试：resetConsecutiveFailures 失败不覆写 completed execution
- 26 个测试全部通过

## 关联

- Issues: #251, #247, #246
- PR: https://github.com/chenlaicai/otter-buddy/pull/312
