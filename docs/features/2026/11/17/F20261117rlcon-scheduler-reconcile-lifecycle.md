---
id: F20261117rlcon
title: scheduler 启动对账分级与历史误标回补：#1510 已完成执行被记「执行被中断」收口
change_type: fix
status: implemented
created: 2026-11-17
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/scheduled-task/scheduled-task-repository.ts
  - src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts
  - tests/usecases/scheduler/scheduler-service.test.ts
  - tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.test.ts
summary: "#1510：定时任务执行收尾与 invoke 生命周期脱钩，进程在 invoke_end 落账后、completeExecution 之前重启时，execution 账面滞留 running，启动对账误标「执行被中断」。回归验证（11-15）在 F20261021sprx 合入后仍抓到 2 条账实相反（21aef3fc/a0c3703f，message_id 为空=旧代码触发未写锚点，invoke 已 invoke_end 但 00:40 对账标 failed）。根因：hasExecutionFreshOutput 空 messageId 直接判无证据，对账无法识别「已交付」。方案：启动对账分级——按 execute-side 证据（锚点后首个 invoke 有无 invoke_end）把已收尾执行翻篇 completed（非 failed），并对历史「执行被中断」failed 行做同判据回补。锚点优先用账面 messageId，空时按触发时间在 5min 窗内回找同任务 scheduler 系统锚点。"
tags: [scheduler, reconciliation, invoke-lifecycle, execution-ledger]
intent:
  problem: "启动对账把已完成（invoke 已收尾）但账面滞留 running/failed 的定时任务执行误标「执行被中断」，账实相反；旧代码触发未写锚点（message_id 空）的执行无法按 message_id 判活，落入误标盲区"
  expected_effect: "已收尾执行在启动对账时按 completed 翻篇（running）或回补（failed），不再误标「执行被中断」；真实中断（无 invoke_end）保持 failed；三连锁各有一条回归用例覆盖"
  verify_by:
    type: capability_test
capability_test: "scheduler-service.test.ts 新增 #1510 对账分级（running+空 messageId+invoke_end→completed）与历史回补（failed「执行被中断」+invoke_end→completed，completedAt 取 invoke_end 时间）两条回归；sqlite-scheduled-task-repository.test.ts 覆盖 getReconciliationFailedExecutions 只取「执行被中断」failed 行"
---

# scheduler 启动对账分级与历史误标回补：#1510 已完成执行被记「执行被中断」收口

## 问题（现场）

2026-11-15 回归验证在 F20261021sprx 合入后仍抓到 2 条账实相反：

- `21aef3fc`（每日补丁清单回看，triggered 10-22T00:00）invoke `0b2b8f4a` 已于 00:02:32 invoke_end，00:40 重启对账却标 failed「执行被中断」
- `a0c3703f`（每日 AI 雷达，triggered 10-22T00:30）invoke `d2f0ec35` 同型

两条 message_id 均为空——**交叉窗口**：旧代码触发未写锚点（attachExecutionAnchor 尚未落地），新代码对账按 message_id 判活直接判死。

## 根因

`hasExecutionFreshOutput` 首行 `if (!execution.messageId) return false;`——空锚点直接判「无证据」，把「已交付」与「真中断」一并翻篇为 failed。启动对账只有「保留 running / 翻篇 failed」两态，无法区分第三种「已收尾」。

## 方案

启动对账分级 + 历史回补，判据统一为**执行侧证据**（锚点后首个 invoke 是否有 invoke_end 落账）：

1. **running 分级**：`findCompletedRunningExecutions` 对账面 running 执行——锚点后首个 invoke_start 关联的 invoke_end 已落账 → 按 completed 翻篇（messageId 回写锚点），不等 failAll。
2. **历史回补**：`repairCompletedFailedExecutions` 扫 `getReconciliationFailedExecutions()`（error_message 含「执行被中断」的 failed 行）——同一判据成立 → 回补 completed，completedAt 取 invoke_end entry 时间。
3. **锚点解析**：优先账面 messageId；空时按触发时间在 5min 窗内回找同任务 scheduler 系统锚点（sender `scheduler:<任务名>`），覆盖旧代码交叉窗口。
4. **真中断保持 failed**：无锚点/无 invoke_start/无 invoke_end 者不做任何翻篇。

## 验证

- 回归：running + 空 messageId + invoke_end → completed（`#1510 对账分级`）
- 回归：failed「执行被中断」+ invoke_end → completed，completedAt=invoke_end 时间（`#1510 历史修复`）
- 仓储：`getReconciliationFailedExecutions` 只取「执行被中断」failed 行，不收普通 failed
- 机械对账断言（issue #1510）：修复合入并重启后，`scheduled_task_executions` 中「status=failed 且 error 含『执行被中断』但对应 invoke 已有 invoke_end」行数收敛为 0（首次启动回补后即自愈）

## 备注

- 交叉窗口涉及的两条坏账（21aef3fc/a0c3703f）由 `repairCompletedFailedExecutions` 在部署后首次启动自动回补，无需手工 SQL。
- 回补幂等：回补后 status=completed，不再进入下一轮 failed 扫描；真实中断行保持 failed，每轮启动只做存在性查询，无副作用。