---
id: F20261013rstk
title: "定时任务 running 执行体滞留挤占治理：轮询级孤儿扫描 + 挤占触发点即时清理 + 挤占 skip 落账（#1449）"
summary: "P0 bug 修复：watchExecutionByLedger 无静默窗（换轨路径专属）——闸门冻结/网关断连时信号永不被点燃，看门狗空转 24h 硬上限才释放执行位，期间同任务后续触发全部被 claim 的 24h 防僵尸判定挡下（10-11/12 现场：2 日 5 次静默 skip + 当日日报缺失）。三道防线：① 轮询级孤儿扫描（tickReal 前置）——running 超 2h 且无存活执行方 → halt + 置 failed + high healing；② 挤占触发点即时清理——claim 前同判据清理后放行本轮，僵尸阈值从 24h 收紧到 2h（阈值倒挂消除）；③ 挤占 skip 落 low healing（1h 节流）——触发被拒即见。判活口径：AgentTurnPort 新增可选 isRunning（AgentInvoker 委托 PiSessionFactory），未注入按无存活；已 halt 打标判死。用户停机/限流冻结（isRunning=true 未 halt）不动账面——信号保留由补扫消化。"
change_type: fix
capability_test: "n/a: 修复为调度内部机械逻辑（执行位生命周期治理），行为面由单测锁定——tests/usecases/scheduler/scheduler-service.test.ts「#1449 running 执行体滞留挤占治理」describe（7 用例：即时清理放行/挤占 skip 落账/1h 节流/停机保护不清仓/halt 判死/轮询兜底/降级装配）；全量 scheduler+agent-runtime 319 用例不回归"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "定时任务执行体滞留 running 状态挤掉后续触发，且只有 24h 硬超时兜底——10-11/12 生产现场 5 次触发被静默 skip（skipped execution 行仅 DB 可查，无任何告警面）、1 个任务挂满 24h 才失败、当日日报缺失（10-12 每日对话健康检查被 skip）。根因链：① 触发路径已换轨信号路由器（#775 S4a），看门狗 watchExecutionByLedger 无静默窗，信号被闸门冻结/网关断连时 isMessageSettled 永 false，空转 24h；② claimAndValidateTask 防僵尸判定阈值 24h（MAX_CHAIN_TIMEOUT_MS）与看门狗硬上限同值——阈值倒挂：清理不先于挤占放行发生；③ 挤占 skip 只落 DB 行，无 healing/告警面。"
  expected_effect: "滞留执行体最长 2h+5min（轮询节拍）内被机械释放（halt 打标 + failed 翻篇 + high healing 落账），挤占触发点即时清理让本轮触发直接放行不等下轮 tick；挤占 skip 1h 节流落 low healing——「任务被挤占」从 DB 考古升级为告警面可见。用户停机/限流冻结（獭 isRunning=true 未 halt）场景账面不动，补扫消化语义不破。回归锁：#1449 七用例 + 既有 85 用例不回归。"
  verify_by:
    type: behavior_check
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/ports/agent-turn-port.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/bootstrap/platforms.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
tags:
  - scheduler
  - reliability
related_issues:
  - 1449
causal_links:
  - "issue #1449: 定时任务执行体滞留 running 挤掉后续触发——24h 硬超时兜底之外的机械清理缺失"
  - "F20260902sgp2（#775 S4a 换轨）: 触发路径走投信号后 watchExecutionByLedger 无静默窗，闸门冻结场景看门狗空转 24h"
  - "#814 调度完整性对账: 互补关系——对账管错过窗口，本修复管挤占根因"
  - "#641 claim 防重复触发: 僵尸判定阈值从 24h 收紧到 2h 的语义演进"
---

# 定时任务 running 执行体滞留挤占治理（#1449）

## 案发现场（issue #1449 原文数据）

| 时间(UTC) | 任务 | 结果 | 备注 |
|---|---|---|---|
| 10-11T17:03 | 依赖升级自动化 | skipped | Task already has a running execution |
| 10-11T23:53 | 未闭环扫描 | skipped | 同上 |
| 10-12 系列 | 每日对话健康检查等 | skipped ×3 | 同上——当日日报缺失 |
| 10-12T~01:00 | 每日补丁清单 | running 挂满 24h | 硬超时才失败 |

根因链三层：

1. **看门狗无静默窗**：触发路径换轨信号路由器（#775 S4a）后，`watchExecutionByLedger` 以 `isMessageSettled` 判活——信号被闸门冻结/网关断连时永 false，看门狗空转到 24h 硬上限才抛错释放执行位。
2. **阈值倒挂**：`claimAndValidateTask` 防僵尸判定用同一个 24h（MAX_CHAIN_TIMEOUT_MS）——清理窗口与挤占放行窗口同值，意味着 24h 内僵尸必挡路、24h 后才放行，中间无任何机械清理。
3. **挤占 skip 静默**：skip 只落 `scheduled_task_executions` 行（DB 可查），无 healing、无告警——「对话几天没跑」要靠人看板偶遇。

## 方案：三道防线

### ① 轮询级孤儿扫描（`reapStaleRunningExecutions`，tickReal 前置）

每轮 tick（5min 节拍）先扫全部 active 任务的 running 执行：

- 判据：`status='running'` 且 `triggeredAt` 超 `RUNNING_STUCK_THRESHOLD_MS`（2h）且目标獭无存活执行方（`isOtterRunning` 未注入按无存活——判不出活就当死，机械清理比等 24h 安全）
- 处置顺序：**halt 打标先于账面翻篇**——执行方真活着（判活口径漏检）时先收到停手指令再看到账面翻篇，避免「账面已死、执行还跑」竞态窗口
- 落账：execution 置 failed（errorMessage 标注 #1449 孤儿清理）+ high healing（日报缺失级事故值得被看见）
- 失败隔离：单任务扫描失败不阻塞其他任务；整轮失败不阻塞 tick 主路径

### ② 挤占触发点即时清理（`reapPreemptingExecutions`，claim 前置）

claim 判定前先对 running 行跑同判据清理：

- 与轮询扫描同判据 + 一道额外保险：**已被 halt 打标的执行方直接判死**（halt=已发停手令，isRunning 残留的 streaming session 只是未收尾的尸身）
- 清理后 2h 内活跃行仍存在才 throw「already has a running execution」；僵尸行不再挡路——本轮触发直接放行（比等下轮 tick 早 ≤5min）
- 僵尸判定阈值从 24h 收紧到 2h：与轮询清理窗对齐（防僵尸窗 ≤ 清理窗），阈值倒挂消除

### ③ 挤占 skip 落账（`recordPreemptionSkipHealing`）

- 触发被 running 挤占时落 low healing（同任务 1h 节流防刷屏——每日补丁清单双触发只落一条）
- fire-and-forget 不阻塞 claim 拒绝主路径；节流状态存内存（重启重置可接受）
- 与 #814 错过窗口对账互补：对账管「该触发没触发」，本条管「触发了但被挤占」的根因可见性

## 判活口径与用户停机保护

- `AgentTurnPort` 新增可选 `isRunning(otterId)`——AgentInvoker 委托 `PiSessionFactory.isRunning`（activeSessions + 池内 streaming 的 U3 口径同源），platforms.ts 装配注入
- **用户停机/限流冻结场景**（isRunning=true 且未 halt）：账面不动——信号保留语义由路由器补扫消化，scheduler 不抢刽子手（锁定用例：「用户停机场景保护」）
- 未注入 isOtterRunning 的降级装配按无存活处理（保守清理优于等 24h）

## Why 2h 阈值

正常任务时长上限 ~1h（日报级），2h 留一倍余量；1h 内即便闸门锁死自愈失败，挤占 healing 也已落账可见（软路径），2h 是硬兜底的机械释放。双轨执行（触发内 24h 看门狗 + 轮询 2h 清理）让「真卡住」与「假卡住」窗口相差 12 倍。

## 测试

`tests/usecases/scheduler/scheduler-service.test.ts` 新增 describe「#1449 running 执行体滞留挤占治理」7 用例：

1. 挤占触发点即时清理：滞留超 2h 且无存活执行方 → fail + halt + high healing + 本轮放行
2. 挤占 skip 落 healing（low）：滞留未超 2h → 本轮 skip + low healing 落账
3. 挤占 skip healing 同任务 1h 节流：连续两次挤占只落一条 low
4. 用户停机场景保护：滞留超 2h 但獭仍 running（闸门冻结）→ 不清仓、信号保留由补扫消化
5. 已 halt 打标的执行方视为死亡：isRunning=true 但 halt 已标 → 仍清仓放行
6. 轮询级扫描兜底：tickReal 先 reap 再扫任务——滞留超 2h 无存活 → fail + healing
7. 未注入 isOtterRunning（降级装配）→ 判不出活按死处理，超阈值即清理

既有 85 用例零回归（含「连续 3 次失败 → error」「claimTask 抢占失败」等 claim 语义锁定用例）。

## 影响范围

- 改动面：`scheduler-service.ts`（三道防线主体）、`agent-turn-port.ts`（isRunning 可选方法）、`agent-invoker.ts`（isRunning 委托）、`platforms.ts`（装配注入）、测试文件
- 行为变化：仅「滞留超 2h 的 running 执行」场景——此前等 24h，现在 2h+5min 内机械释放；正常任务（1h 内完成）零感知
- 回滚面：revert 本 PR 即回 24h 硬上限单轨兜底（旧行为）
