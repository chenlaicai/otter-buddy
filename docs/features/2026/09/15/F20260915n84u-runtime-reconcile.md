---
id: F20260915n84u
title: 运行时定期调度对账：tick 循环死亡时错过窗口仍可见
summary: 修复 #823——9/6 现场：服务在线但轮询 tick 循环整体死亡（setInterval 异常静默/事件循环假死），self-healing-analysis 错过 18:00 窗口、2 条 healing events 悬置 28h。#814 启动对账只覆盖重启时刻，对「在线但漏触发」盲区。修复：reconcileMissedWindows 挂到独立的 1 小时定时器上（与 pollTimer 冗余隔离），tick 死了对账仍响；复用既有按窗口去重，重复报零成本。另落地 tickImpl 测试注入口子。
type: feature
status: development
created: 2026-09-15
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
modules: [scheduler]
closes_issue: 823
intent:
  goal: 服务在线但调度 tick 死亡时，错过触发窗口在 1h 内落 healing 台账，不再依赖次日人肉发现
  why: 9/6 实证现场（#823）：其他任务正常 ≠ 本任务正常——tick 循环整体死亡时 #814 启动对账完全帮不上；2 条 healing events 因此悬置 28h
  non_goals:
    - 不排查 tick 循环死亡的根因（setInterval 为何静默）——本特性只保证「死了能被发现」，根因排查登记后续
    - 不改变补触发语义（#640 轮询补触发逻辑不动）
---

# 运行时定期调度对账：tick 循环死亡时错过窗口仍可见

## 目标

1. 运行时定期（1h）复跑 `reconcileMissedWindows`，挂在**独立于 pollTimer 的第二个 setInterval** 上
2. 对账定时器 unref + stop() 清理 + 防重复启动
3. 落地 `tickImpl` 测试注入口子（隔离轮询补触发，让对账定时器可独立验证）

## 根因分析（#823，代码 + 数据双重证据）

**现场**（DB 实证）：
- 9/6 18:00（UTC 10:00）self-healing-analysis 触发窗口**完全缺失**——scheduled_task_executions 无成功/失败/skipped 记录
- 同日 01:15Z 一批任务触发后，**9/6 全天再无任何任务触发**；9/7 00:04Z 起全部恢复
- 后果：2 条 healing events（degenerate/circuit_break）悬置 28h 无人消费

**根因推断**（置信度：中——现象级证据，无 tick 死亡直接日志）：
- 排除「单任务异常」：对照组任务同日也全部无触发（与 issue 原始记录「其他任务正常」矛盾——DB 实查纠正）
- 排除「进程死亡」：服务在线（healing events 持续落账）
- 指向：**轮询 tick 循环在 9/6 01:15 后整体死亡**（setInterval 异常静默或事件循环假死），进程重启（9/7 00:04 前）后自愈
- #814 启动对账只在 start() 跑一次——对「在线但 tick 死亡」场景零覆盖

## 方案设计

| 决策 | 选择 | 理由 |
|---|---|---|
| 对账周期 | 1h | 错过窗口发现时效从「次日健康检查」缩到 1h；对账自带去重，重复报零成本 |
| 定时器布局 | **独立 setInterval**（非挂在 tick 内） | 对账的意义就是 tick 死亡时仍可见——挂在 tick 上等于没有冗余；双定时器同时死的概率远低于单个 |
| 落账逻辑 | 复用 `reconcileMissedWindows` 原样 | #814 已实现判定 + #853 去重 + #929 容差，零重复建设 |
| tick 注入 | `SchedulerServiceOptions.tickImpl`（生产不传） | 测试需隔离 30s 轮询补触发，否则无法断言「落账来自对账定时器」 |

## 影响范围

- `src/usecases/scheduler/scheduler-service.ts`：`RUNTIME_RECONCILE_INTERVAL_MS` 常量 + `reconcileTimer` 字段 + `startRuntimeReconcile()` + start() 接线 + stop() 清理 + tickImpl 注入（tick 拆 tick/tickReal）
- `tests/usecases/scheduler/scheduler-service.test.ts`：3 个新用例（运行时落账 / 去重 / stop 清理）+ createMockCronParser 支持可变 prevDue

## 取舍

- **不排查 tick 死亡根因**：setInterval 静默死亡难以直接观测，本特性先把「死了不可见」修成「死了 1h 内响铃」；根因排查登记 issue（如有复发，对账事件本身就是侦察数据）
- **1h 而非更短**：对账查 healingRepo.findOpen 全量 open 事件，频率过高浪费 IO；1h 对「错过窗口」场景足够（任务粒度均为分钟级以上）

## 验证

- scheduler 域 80/80（含 3 新用例）；全量 3023/3023 + tsc 0
- 新用例覆盖：运行时对账独立落账（tickImpl noop 隔离）/ 同窗口去重（3h 3 次对账仍 1 条）/ stop 后定时器清理
- 测试反模式防线实证：开发中发现「getNextTime mock 返回固定时间 + 不定系统时间 → setTimeout 负延迟 → Node 钳到 1ms → fake timer 立即触发风暴」假失败形态，用 vi.setSystemTime 根治（此形态值得进 #544 静态扫描规则库）

## 决策史

- 2026-09-15 大獭 DB 实查纠正 issue 原始记录：9/6 并非「只有 self-healing-analysis 缺失」而是「01:15 后全天所有任务无触发」——根因从「单任务漏触发」修正为「tick 循环整体死亡」
- 2026-09-15 方案：独立定时器运行时对账（issue 修复方案短期项的原样落地）
