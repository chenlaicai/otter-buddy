---
id: F20260915ushm
title: 巡检 worker：四个扫台账循环合并为单一定时器（8→5 常驻循环）
summary: 落地 #949（chen「后台循环太多」裁决的结构化后半截）：运行时对账（#823）/ Signal Aging（#927）/ RHI Scan（#401）/ Embedding Retry（F20260812mrcq）四个同构「定时醒来扫台账」循环合并为单一 PatrolWorker——一个 1h setInterval 按序驱动四家职责，常驻循环 8→5。职责注册接口（PatrolDuty name+run）+ 失败隔离（一家炸不影响后续）+ start 幂等/stop 等 in-flight。SchedulerService 删 #823 独立对账定时器改暴露 reconcileMissedWindowsNow 公共方法；EmbeddingRetryWorker start() 不再自持定时器（PatrolWorker 调 tickNow）。闹钟盘点报告（timer-audit-20260915）的合并处方落地。
type: feature
status: development
created: 2026-09-15
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
modules: [scheduler, health, memory]
closes_issue: 949
capability_test: tests/usecases/health/patrol-worker.test.ts（6 用例）+ tests/usecases/scheduler/scheduler-service.test.ts（#823 三用例改写为公共方法驱动 + 1 契约用例锁死「service 无自持对账定时器」）
intent:
  goal: 四个同构「扫台账」循环合并为单一巡检 worker，消灭样板代码与循环数量膨胀
  why: chen 15:09 裁决「后台循环太多」；盘点实查 8 个常驻 setInterval 中四个同构（定时醒来→扫台账→异常落账），#948 降频治标、本特性合并治本
  non_goals:
    - 不动 Polling 本体（#640 App Nap 病根，#948 已降频 5min）
    - 不动 SSE keep-alive / 执行级看门狗 / 微信 polling（非闹钟语义）
    - RHI 改 on-demand 另案（#950 待拍板）
---

# 巡检 worker：四个扫台账循环合并为单一定时器

## 方案

**PatrolWorker（src/usecases/health/patrol-worker.ts）**：职责注册模式——各家实现 `PatrolDuty { name, run() }`，worker 持单个 1h setInterval 按序驱动。

| 职责（注册顺序） | 原循环 | 合并后驱动方式 |
|---|---|---|
| scheduler-reconcile | #823 独立 1h 定时器（scheduler-service 内） | 删定时器，暴露 `reconcileMissedWindowsNow()` 公共方法 |
| signal-aging | signal-aging-worker 1h 定时器 | 调 `scanOnce()`（其 start/stop 自持定时器保留但 app.ts 不再 start——纯职责化） |
| rhi-scan | rhi-scan-worker 1h 定时器 | 调 `scanOnce()`（同上） |
| embedding-retry | embedding-retry-worker 1h 定时器（#948 降频后） | start() 改为仅标记可工作，PatrolWorker 调 `tickNow()` |

**失败隔离**：每家 try/catch 落 error 日志（带职责名），一家炸了不影响后续——与合并前各自 tickSafely 语义对齐。

**周期**：1h（四家原节奏已对齐，无时钟语义变化）；启动即巡一轮（对齐 signal-aging 的存量发现语义）。

## 影响范围

- 新增：`src/usecases/health/patrol-worker.ts` + `tests/usecases/health/patrol-worker.test.ts`（6 用例）
- `src/app.ts`：四个独立 start 替换为 PatrolWorker 注册 + start；dispose 统一 `patrolWorker.stop()`
- `src/usecases/scheduler/scheduler-service.ts`：删 #823 reconcileTimer/startRuntimeReconcile/RUNTIME_RECONCILE_INTERVAL_MS，新增 `reconcileMissedWindowsNow()`
- `src/usecases/memory/embedding-retry-worker.ts`：start() 不再自持定时器（JSDoc 注明 PatrolWorker 驱动）
- `tests/usecases/scheduler/scheduler-service.test.ts`：#823 三用例改写（定时器推进 → 公共方法直接调用）+ 1 契约用例（锁死 service 无自持对账定时器，防未来双驱动回归）

## 取舍

- **signal-aging / rhi-scan 的 start/stop 方法保留**（其内部定时器逻辑未删——app.ts 只是不再调 start）：保留「独立运行」的降级路径，若 PatrolWorker 出问题可一行切回；代价是两份启动路径并存的认知成本（JSDoc 已注明）
- **embedding-retry 的 timer 字段保留**（stop/stopSync 的 clearInterval 仍引用）：字段不再被 start 赋值，clearInterval(null) 是 no-op，不动字段保持 diff 最小
- **对账排第一**：调度健康是四家里面向明天最早可见的（早报 9 点档），其余三家无顺序敏感性

## 验证

- 全量 3074/3074 + tsc 0 + eslint 0
- PatrolWorker 6 用例：顺序执行/失败隔离/启动即巡+周期/start 幂等/stop 清理/stop 等 in-flight
- scheduler #823 用例改写后 68/68（含新契约用例：service 推进 2h 零新落账——无自持定时器铁证）
- embedding-retry 域 12/12（start() 语义变化无回归——其测试全显式驱动 tickNow/tick，不依赖定时器）

## 决策史

- 2026-09-15 15:09 chen「后台循环太多」裁决 → 盘点（timer-audit-20260915）
- 2026-09-15 #948 降频（治标）合入；#949 合并（治本）开 issue
- 2026-09-15 17:00 chen「开工开工」→ 本特性实现
