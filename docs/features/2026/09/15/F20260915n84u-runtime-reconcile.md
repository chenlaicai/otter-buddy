---
id: F20260915n84u
title: 调度饿死根治：skip 不吞 claim + expected 缓存重算 + 运行时对账兜底
summary: 修复 #823——9/6 现场日志取证实锤：self-healing-analysis 动态 skip（无 open events）吞掉 claim 但不建 execution，Polling tick 的 expected 缓存因此永久停在旧窗口（饿死自锁、零日志），任务错过 18:00 窗口、2 条 healing events 悬置 28h。根修三层：resolveEffectiveBody 移到 claim 前（skip 不吞 claim）+ tick 重算 expected（解锁饿死自锁）+ 运行时 1h 对账降级为兜底。另落地 tickImpl 测试注入口子。
type: feature
status: development
created: 2026-09-15
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
modules: [scheduler]
closes_issue: 823
capability_test: tests/usecases/scheduler/scheduler-service.test.ts（#814/#823 系列 10 用例：启动对账 5 + 运行时对账 3 + 根修 2）
intent:
  goal: 根治调度饿死——动态 skip 不吞 claim（D1）、Polling expected 缓存不自锁（D2），任务不再静默错过窗口；运行时 1h 对账作未知形态的兜底可见性
  why: 9/6 日志取证实锤（#823）：skip 吞 claim + expected 自锁合谋让任务饿死 22h 零日志，2 条 healing events 悬置 28h；上午版「tick 死亡」误判已勘误
  non_goals:
    - 不处理 cron 级漏触发的补跑策略（错过就错过，落账即可；补跑语义归 #854 运行时对账议题）
    - 不改变补触发语义（#640 轮询补触发逻辑不动）
---

# 调度饿死根治：skip 不吞 claim + expected 缓存重算 + 运行时对账兜底

## 目标

1. 运行时定期（1h）复跑 `reconcileMissedWindows`，挂在**独立于 pollTimer 的第二个 setInterval** 上
2. 对账定时器 unref + stop() 清理 + 防重复启动
3. 落地 `tickImpl` 测试注入口子（隔离轮询补触发，让对账定时器可独立验证）

## 根因分析（#823，日志取证实锤——2026-09-15 下午复核修正）

**9/6 完整时间线**（data/logs/otter-buddy.log + DB 交叉取证）：

1. 9/6 01:15:02Z 老进程（pid 92087）Polling tick 判 5 任务 overdue，catch-up 全部 fire-and-forget 触发——任务跑了（01:15 批次 executions 有记录）
2. 01:23:41Z 老进程收 SIGTERM 死亡；01:24:30Z 新进程（pid 72041）启动，启动对账把 2 条僵尸 running execution 翻篇 failed
3. 01:30:00Z 新进程 setTimeout 快路径准时触发 backlog digest（execution 落账 completed）——**调度器此时是活的**
4. 01:59:58Z self-healing-analysis 的 Timer fire → claimTask 成功（last_triggered_at 更新）→ resolveEffectiveBody 返回 null（无 open events）→ **skip：claim 被吞但不建 execution、无痕迹**
5. 02:00:00Z **第二个 Timer**（Polling catch-up 的 `.then` 里 `scheduleNext(task)` 重复注册的）fire → claim 被拒（60s 窗口）→ 「Failed to trigger task」日志
6. 此后 Polling tick 每 30s 跑，但对 cc1cfa4f：`expected` 缓存停在 02:00（**claim 被拒后无人重算**），`lastTriggeredAt` 已是 01:59:58（POLL_INTERVAL 内）→ 每轮静默 continue——**任务永久饿死，且饿死状态不触发任何日志**
7. 9/7 00:04Z 进程重启（又一次 SIGTERM 周期）→ 缓存清零 → 恢复

**三层缺陷（全部实锤）**：

| 层 | 缺陷 | 位置 |
|---|---|---|
| D1 | **skip 吞 claim**：resolveEffectiveBody 在 claim 之后执行——动态 skip（无 open events）消耗 claim（last_triggered_at 前进）但不建 execution、不留痕迹 | triggerTask 步骤顺序 |
| D2 | **expected 缓存不死**：Polling tick 判「expected 已过 + lastTriggeredAt 新近」时静默 continue，从不重算 expected——饿死状态自锁 | tick() 比对分支 |
| D3 | **双 Timer 竞态**：Polling catch-up `.then` 无条件 scheduleNext(task)，与 setTimeout 快路径既有 Timer 叠加——同任务两个 Timer 互踩 claim（02:00:00.001 的 Failed to trigger 即互踩产物） | tick() catch-up then 块 |

**对 issue 原始记录与上午版的两次修正**：issue 写「只有 self-healing-analysis 缺失、其他任务正常」——DB 实查为「01:15 后全天所有任务零触发」；上午版推断「tick 循环整体死亡」——日志实锤 **tick 一直在跑，是 D1+D2 合谋让饿死在 tick 眼皮底下隐形**。「修分针」就是修 D1/D2/D3，不是再挂一个小闹钟。

## 方案设计

**根修（本 PR 主体，应 chen 14:05 裁决「修分针，不挂小闹钟」重写）**：

| 决策 | 选择 | 理由 |
|---|---|---|
| D1 修复 | **resolveEffectiveBody 移到 claim 之前**——动态 skip 不再消耗 claim，last_triggered_at 不前进，后续窗口照常可触发 | 顺序调换零新机制；skip 加 info 日志留痕 |
| D2 修复 | **tick 重算 expected**：expected 已过但 lastTriggeredAt 在 POLL_INTERVAL 内（被无 execution 的 trigger 刷新）→ getNextTime(now) 重算推进缓存 | 饿死自锁状态的唯一解锁点 |
| D3 修复 | catch-up `.then` 里的 scheduleNext 保留（它本来就先 clearTimeout 旧 Timer——实查 scheduleNext 有 clear 逻辑，双 Timer 实为 01:30 前旧 Timer 与 catch-up 重设 Timer 的交替，非泄漏）；**真正的竞态防护是 D1 修复后 skip 不吞 claim，互踩窗口自然消失** | 不过度设计 |
| 运行时定期对账（上午版主体） | **保留但降级为兜底**：D1/D2 修好后饿死不再隐形，1h 对账变成双保险（防未来未知饿死形态），不再是主防线 | chen 裁决不卡「多一个机制」——对账复用既有逻辑零新判定，保留成本低 |
| 验证（发现时效） | 对账 1h 周期从「既有窗口已错过」起算，非从死亡起算——极端情况发现延迟 = 1h（对账周期）+ 窗口间隔 | 任务粒度均分钟级以上，可接受 |

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

## 现场勘误（2026-09-15 下午，应 chen「修分针」裁决重查）

- 上午版（d265e765）把根因定为「tick 循环死亡」——**错**。日志实锤 tick 一直在跑；真正机制是 D1（skip 吞 claim）+ D2（expected 缓存自锁）
- 上午版交付的 1h 对账定时器 + tickImpl 注入 + 3 用例保留（降级为兜底）；下午补 D1/D2 根修 + 2 根修用例

## 决策史

- 2026-09-15 大獭 DB 实查纠正 issue 原始记录：9/6 并非「只有 self-healing-analysis 缺失」而是「01:15 后全天所有任务无触发」——根因从「单任务漏触发」修正为「tick 循环整体死亡」
- 2026-09-15 方案：独立定时器运行时对账（issue 修复方案短期项的原样落地）
