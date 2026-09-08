---
id: F20260908schm
title: "调度完整性对账：启动时错过触发窗口落 healing 台账（closes #814）"
summary: "9/5 全天静默：3 个 cron 任务触发窗口整体错过且零记录——healing 无事件、consecutive_failures 不计数、重启后无补扫。修复：scheduler start() 对 active cron 任务做对账——cronParser.getPrevTime（croner previousRuns）取最近一次应触发时间，lastTriggeredAt 落后即落 healing event（errorType=other，severity=low，context 含 cron/错过窗口/lastTriggeredAt），静默日在台账与日报可见。"
change_type: feature
capability_test: "n/a: 纯代码逻辑改动（A 类），无 LLM 参与行为"
created_in_conversation: 303b94d4-b3ad-4de4-9ee4-2b54da95f9a2
tags: [scheduler, healing, observability, missed-trigger, daily-review]
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - src/frameworks/scheduler/cron-parser.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
created_at: 2026-09-08
---

# 调度完整性对账（closes #814）

## 背景

9/5 全天系统静默：messages 0 条、scheduled_task_executions 无 9/5 记录，但当日应有 3 个 cron 任务触发（健康检查 09:00 / self-healing 10:00 / backlog digest 09:30）。错过的触发窗口无任何系统记录——服务停机期间无进程可写，重启后无「补扫错过窗口」机制。

## 修复

### 1. CronParser 扩展（可选方法）

`CronParser` 接口新增可选 `getPrevTime(cron, timezone, referenceTime?)`——取 referenceTime 之前最近一次应触发时间。`SimpleCronParser` 用 croner 的 `previousRuns(1, ref)` 实现。可选是为了不破坏既有 mock（旧实现缺该方法时对账自动跳过）。

### 2. 启动对账（scheduler-service.start）

`reconcileMissedWindows(tasks)`：对每个 active cron 任务——
- `prevDue = getPrevTime(cron, tz, now)`（最近一次应触发时间）
- 参照点 = `lastTriggeredAt ?? createdAt`
- 参照点 < prevDue → 该窗口被错过 → 落 healing event（`errorType='other'`，`severity='low'`，context 含 `cron / missedWindowAt / lastTriggeredAt / reconciledAt`）

设计取舍：
- **每任务只报最近一次错过窗口**：停机跨多个窗口时逐窗口报会刷屏；最近一次已含「有静默」的全部信息，更早窗口由日报对账覆盖（issue 方案的可选增强，未做——机制预算：先最小可见性，观察是否够用）
- **不补跑**：错过窗口的补跑语义因任务而异（健康检查补跑有意义，提醒类任务补跑是打扰），对账只负责可见性
- **对账失败不阻塞启动**（best-effort，与 #775 启动对账同款）

## 测试

3 条新用例：
1. lastTriggeredAt 落后于应触发时间 → 落 low 级 healing 事件（context 字段断言）
2. lastTriggeredAt 不落后 → 零事件
3. cronParser 不支持 getPrevTime（旧实现）→ 跳过对账不报错

60/60 全绿（57 既有 + 3 新增），tsc 0 error。

## 验证

- 9/5 场景回放：若 9/6 09:05 重启时本机制在位，3 个任务各落一条 low 事件（prevDue=9/5 窗口，lastTriggeredAt=9/4 17:00）——issue 验收标准满足
- 最简检查：croner 原生 previousRuns + 既有 healingRepo 注入，零新依赖
- 集成验证留待下次真实停机/重启后观察（healing 台账应出现对账事件）

## Discovered Issues

无。
