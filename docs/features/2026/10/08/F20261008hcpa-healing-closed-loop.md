---
id: F20261008hcpa
title: "healing 治本三层改造：打断-疏通-接盘（#1356）"
summary: "healing 事件「升级信号无人接盘」根治——层1 打断（guard bounce 上限 3→2，同规则第3次拦截直接升级走人）、层2 疏通（restart-service.mjs 新增 kill-by-pid 子命令，按 PID 受控终止自有项目进程）、层3 接盘（autoStaleDismiss 排除 high + 超龄 high 推 healing-alert-registry + self-healing-analysis 对 high 强制 bind_issue）"
change_type: feature
capability_test: "n/a: 守卫参数调整 + repo 层 severity 分层 + 调度层 alert 推送，验证走单测（stale-severity/kill-by-pid/guard-bounce/scheduler-service），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - "#1356"
  - "#844"
  - "F20261008gfrc"
  - "F20260914dsrv"
tags:
  - healing
  - guard
  - governance
  - scheduler
modules:
  - src/usecases/conversation/agent-turn-orchestrator/retry-policy.ts
  - src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts
  - scripts/restart-service.mjs
  - src/frameworks/db/healing/sqlite-healing-event-repository.ts
  - src/usecases/healing/healing-event-repository.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/bootstrap/platforms.ts
  - prompts/scheduled/self-healing-analysis.md
intent:
  problem: "healing 事件治理三重断裂：①升级通道终点只是 severity 标签无后续动作（27 条 high 挂着无人处置）；②控制信号终态后獭仍撞墙（e8e21216 六分钟 7 次重复拦截）；③autoStaleDismiss 无 severity 过滤（high 可被时间静默，#1356 治理洞）。9:00 self-healing-analysis 每天清库但产消速率差导致 9 点后新产事件无人管"
  expected_effect: "层1：同规则第3次拦截不再自动回发，直接升级（abort+healing high+系统消息）——打断更早，升级信号不被无视。层2：kill-by-pid 子命令提供受控 PID 终止入口（白名单/cwd 归属/主进程拒绝三重校验）——疏通正当诉求。层3：high 不被时间静默（autoStaleDismiss 排除 high），超龄 high 24h 推 alert-registry 提醒大獭，消费任务对 high 强制 bind_issue——升级信号有接盘"
  verify_by:
    type: behavior_check
    detail: "单测覆盖：stale-severity（autoStaleDismiss 排除 high + ageOutHighAndNotify 取回/幂等/不参与 resolved）、kill-by-pid（assertKillByPidSafe 静态校验 8 用例）、guard-bounce（GB-3 上限 2 语义）、scheduler-service（alert 推送/resolver 降级/无超龄不 warn）。全量 4971/4971 + tsc 0 错"
created_at: "2026-10-08T16:15:00+08:00"
---

# healing 治本三层改造：打断-疏通-接盘（#1356）

## 背景

9/14 #844 修完后（端口白名单+restart-service.mjs+重复拦截升 high），healing 事件治理仍有三重断裂：

1. **升级无后续**：#844-C 生产的 high 事件（变体重试 ≥3 次升级）只是 severity 标签，无强制处置动作——27 条 high 挂着无人管
2. **撞墙无打断**：控制信号 3/3 终态后獭仍继续撞墙（e8e21216 六分钟 7 次），guard bounce 上限 3 次太宽容
3. **时间静默无分层**：autoStaleDismiss 每日批量 dismiss 超龄 open 事件，无 severity 过滤——high 升级信号可被时间静默（#1356 治理洞）

9:00 self-healing-analysis 每天清库（resolve 76 条），但产消速率差导致 9 点后新产事件（73 条 open、27 条 high）无人处置。

## 方案

### 层1 打断（guard bounce 上限收紧）

`retry-policy.ts`：`GUARD_BOUNCE_MAX` 3→2。同规则第 3 次拦截不再自动回发，直接走升级路径（abort 终态 + 系统消息 + healing high）。

### 层2 疏通（kill-by-pid 子命令）

`scripts/restart-service.mjs` 新增 `kill-by-pid` 子命令：按 PID 受控终止自有项目进程。安全不变式与端口路径同构（白名单/cwd 归属/主进程拒绝），只是换了个寻址方式。`assertKillByPidSafe` 纯函数导出供单测。

### 层3 接盘（high 不被静默 + 超龄提醒 + 强制归口）

- `sqlite-healing-event-repository.ts`：`autoStaleDismiss` 排除 high（`severity <> 'high'`），新增 `ageOutHighAndNotify(staleDays)` 取回超龄 high 并置 dismissed
- `scheduler-service.ts`：healing 分析任务中调用 `ageOutHighAndNotify(1)`（24h），返回非空时推 `healingAlertRegistry`（healing 主对话），resolver 不可达时静默降级（提醒丢一次，台账不丢）
- `prompts/scheduled/self-healing-analysis.md`：high severity 硬规则——必须 bind_issue 归口到 GitHub issue，不得直接 dismiss/resolve

## 影响范围

- 守卫行为：guard bounce 上限 3→2，第 3 次拦截直接升级（更早打断）
- healing 事件生命周期：high 不再被 autoStaleDismiss 时间静默，超龄走 alert-registry 提醒
- self-healing-analysis 消费：high 事件必须 bind_issue，不得静默处置
- 运维操作：kill-by-pid 提供按 PID 终止入口（场景：僵尸进程/测试残留）

## 取舍

- **上限 2 而非 1**：第 1 次拦截仍给自纠机会（bounce 回发），第 2 次再拦说明獭没听懂，第 3 次直接升级——比 3 次更早，但保留了自纠窗口
- **24h 而非 30 天**：high 超龄提醒窗口比 staleDays(30) 紧 30 倍——升级信号挂 24h 无人处置就推大獭，不等月度清理
- **resolver 懒解析**：healing 主对话 ID 经 settings 仓异步解析（构造期 ensureHealingConversation 可能未就绪），不可达时静默降级——提醒可丢一次，台账不丢

## 验证

- `sqlite-healing-event-repository-stale-severity.test.ts`：autoStaleDismiss 排除 high、ageOutHighAndNotify 取回/幂等/不参与 resolved（4 用例）
- `restart-service-kill-by-pid.test.ts`：assertKillByPidSafe 静态校验（8 用例：PID 合法性/主进程/自身/projectDir 边界）
- `agent-invoker-guard-bounce.test.ts`：GB-3 上限 2 语义（seed 2 条→第 3 次升级）
- `scheduler-service.test.ts`：alert 推送/resolver 降级/无超龄不 warn（3 用例）
- 全量 4971/4971 + tsc 0 错
