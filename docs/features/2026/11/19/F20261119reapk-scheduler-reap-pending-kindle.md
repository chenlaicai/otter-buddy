---
id: F20261119reapk
title: "scheduler 机械释放补 pending 入列：「恢复后由补扫消化」的载体保证（#1893）"
summary: "定时任务执行体滞留超 2h 机械释放（翻篇 failed + healing）后，当轮工作失去全部载体——注入消息悬空、无 pending 兜底，11-13 健康检查当日 daily-review 缺失实证。根因是双触发抑制链：首触发 running 滞留（冻结未消费），二次触发被同槽 running 抑制成不入列的账面 completed（message_id=NULL），机械释放只回收账面不管消化载体，「恢复后由补扫消化」停在注释口号。修法：两释放点（轮询+挤占）翻篇后补 kindleReapPending——同槽无其他 running 且无真直发 completed（抑制型不算覆盖）则 enqueue pending（保原槽位，恢复后经既有提醒通道补做/弃做留痕）；once 不入列；索引去重静默；healing context 带 pendingKindled。KeepAlive 探针为长期项不进本 PR。"
change_type: bugfix
capability_test: "n/a: 纯代码逻辑修复非 LLM 行为采样面——入列判定矩阵由 6 例单测覆盖（tests/usecases/scheduler/scheduler-service.test.ts F20261119reapk describe 块：实证场景/同槽 running/真直发覆盖/索引去重/挤占路径/once 守卫）；现场维度的验证载体是后续 healing 落账 context.pendingKindled 与 pending 项消费留痕"
intent:
  problem: "机械释放的语义缺口：reapStaleRunningExecutions 只做「账面翻篇 + healing 落账」，隐含假设「恢复后由补扫消化」——但补扫消化的载体（pending 项）在双触发抑制链下恰好不存在。11-13 实证：00:51 首触发注入后执行方冻结，消息悬空；00:56 二次触发走忙判入列路径，covered 判定同槽 running 已覆盖→不入列、execution 落 completed（message_id=NULL 账面完成）；02:54 机械释放首触发后，当轮工作无任何载体。对照组：11-14/16/18/19 每天「execution 秒完成 + 同时刻 pending 项」成对存在，唯独 11-13 断链。"
  solution: "机械释放与消化载体绑定为原子动作：reapStaleRunningExecutionsForTask（轮询扫描）与 reapPreemptingExecutions（挤占触发点）翻篇 failed 后调 kindleReapPending——守卫（pendingItemRepo 未注入/once 任务）短路；同槽覆盖判定用两个既有原语（hasExecutionInSlot(['running'], 排除自己) 防双跑重复、hasDirectCompletionInSlot 真直发 completed=已覆盖），抑制型 completed（message_id=NULL）显式不算覆盖（正是事故形态）；enqueue 由部分唯一索引去重（同任务已有 pending=已有载体，静默返回 false）；triggeredAt 用原 execution 槽位保持同 cron 槽对账语义。healing context 增 pendingKindled，suggestion 按入列结果分叉。失败仅日志不阻塞释放本体（释放是主语义，入列是增强）。"
  expected_effect: "执行方冻结恢复后，被机械释放的当轮任务经 pending 提醒通道可见可补做（消费留痕：补做或弃做均记 resolution）——「恢复后由补扫消化」从注释口号变为有载体的可执行语义；正常双触发/真完成场景零行为变化（覆盖判定短路）；次日 cron 自然覆盖仍兜底。"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [scheduler, reap, pending, kindle, stalled-execution, catch-up]
modules:
  - scheduler
causal_links:
  - {type: "fixes", id: "issue#1893", note: "running 执行体滞留超 2h 机械释放——本 PR 补消化载体；KeepAlive 外部探针（M-0fa0a734 进程停机无外部哨兵）保持 issue 关联不在此范围"}
  - {type: "complements", id: "F20261119sprmd", note: "同域先例：roster miss 降级入 pending（degradeRosterMissToPending）——本 PR 复用同一 pending 通道与索引去重语义"}
  - {type: "same-family", id: "F20260901schd", note: "调度器三连修（轮询补触发+claim 竞态+429 看门狗） lineage——本 PR 收窄到机械释放后的消化载体缺口"}
---

# scheduler 机械释放补 pending 入列（F20261119reapk）

## 事故现场（#1893 数据实证）

11-13 健康检查（taskId b7b6639f，cron 30 8 * * *）完整断链：

| 时刻 | 事件 | 载体状态 |
| --- | --- | --- |
| 00:51:37 | catch-up 补触发（execution 9b966a4e，running）——执行方睡眠冻结，注入消息未消费 | 消息悬空 |
| 00:56:38 | 下一 tick 二次触发（execution 4344ce66）——忙判=busy（首触发在跑）→ `covered` 判定同槽 running 已覆盖 → **不入 pending**，execution 落 completed（message_id=NULL 账面完成） | 无 pending 项 |
| 02:54:13 | 轮询扫描机械释放 9b966a4e → failed + healing（4a2fde07）——只回收账面 | 当轮工作失去全部载体 |
| 当日 | 健康检查 daily-review issue 缺失（11-13 无产出） | 目标丢失，无人补跑 |

对照组实证：11-14/16/18/19 每日「execution 秒完成 + 同时刻 pending 项」成对存在（pending_items 表），唯独 11-13 断链——机械释放后补扫消化无载体不是假设，是实据。

同型第二例：self-healing-analysis（cc1cfa4f）11-14 看门狗放弃 4h + 11-16 机械释放（31a75a64）——两天两任务证实系统性缺口（issue 范围补充已记录）。

## 根因：双触发抑制 × 机械释放无载体

`claimAndValidateTask` 的忙判路径（scheduler-service.ts）对 cron 任务：「同槽位 running/completed 已覆盖本轮，failed/skipped 不抑制（pending 兜失败重试）」——但这个「兜」只在**触发时**生效。机械释放发生在**触发之后**（2h 阈值），它翻篇的正是当时提供「覆盖」的那条 running：

1. 首触发 running 滞留（冻结）→ 它是二次触发的 covered 依据（running 算覆盖）
2. 机械释放把它翻篇 failed → covered 依据消失，但已没有人再看一眼是否需要补 pending
3. 「恢复后由补扫消化」的注释假设信号保留语义兜住——但信号保留只保证「消息还在」，不保证「有人回头消费」（冻结恢复后无重燃点）

## 修法：kindleReapPending（机械释放与消化载体绑定）

```ts
// 两个释放点翻篇后：
const kindled = await this.kindleReapPending(task, exec);
await this.recordReapHealing(task, exec.id, kindled);
```

判定链（全部复用既有原语，零新表零新索引）：

1. **守卫短路**：pendingItemRepo 未注入（降级装配）/ once 任务（行触发后即删，pending FK 悬空）→ 不入列
2. **同槽另有 running** → 不入列（防双跑重复——挤占触发点释放后新触发在跑的场景）
3. **同槽有真直发 completed**（hasDirectCompletionInSlot：completed 且 message_id 非空）→ 已覆盖不入列
4. **抑制型 completed（message_id=NULL）不算覆盖**——正是 11-13 事故形态：账面完成≠工作有人干
5. **enqueue**：triggeredAt 用原 execution 槽位（次日消费按同 cron 槽对账）；部分唯一索引去重（同任务已有 pending=已有载体，返回 false 静默）
6. **healing context.pendingKindled** 落账，suggestion 分叉（入列→「已补 pending 入列，恢复后经 pending 通道重燃补做」；未入列→「同槽已覆盖/去重/once，次日 cron 自然覆盖」）

失败仅日志不阻塞释放本体——释放是主语义（回收执行位），入列是消化增强。

## 边界（已知与不修）

- **执行方恢复后仍不主动消费**：pending 项的可见性依赖既有提醒通道（manage_scheduled_task_pending 工具+獭就位提醒）；若执行方长期不活跃，次日 cron 触发时消费判定「过期即弃」或「补做」由消费獭裁量留痕——本 PR 保证载体存在与可见，不强制补做语义（定时任务允许漏一次执行是 #1048 搭档定调，克制优先）
- **KeepAlive 外部探针不在本 PR**：进程停机无外部哨兵（issue 长期方案，关联 M-0fa0a734）是独立工程（外部 watchdog 进程），保持 issue 关联
- **冻结根因不治**：睡眠冻结/限流是系统外因，机械释放+载体兜底是可做的全部

## 验证

- 单测 6 例（tests/usecases/scheduler/scheduler-service.test.ts，F20261119reapk describe）：
  1. 11-13 实证场景：轮询翻篇 + 同槽仅抑制型 completed → 入列（槽位/任务/角色/对话四字段断言 + pendingKindled=true）
  2. 同槽另有 running → 不重复入列
  3. 同槽真直发 completed → 已覆盖不入列
  4. 索引去重（enqueue 返回 false）→ 静默、pendingKindled=false
  5. 挤占触发点路径同样入列 + 新触发放行不冲突
  6. once 守卫不入列
- 全量 scheduler-service 123 例绿；tsc/eslint 绿
- 现场观察项（后续 healing 落账）：机械释放事件的 context.pendingKindled 分布与 pending 项消费 resolution 留痕
