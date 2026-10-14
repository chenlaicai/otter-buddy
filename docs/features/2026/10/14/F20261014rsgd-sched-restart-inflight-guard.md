---
id: F20261014rsgd
title: "定时任务触发前重启的在途互斥守卫"
summary: "restartBeforeInvoke 重启执行獭 session 前不检查在途执行，导致同獭串行任务互相掐断（8:00 补丁清单被 8:30 健康检查重启掐断）。在重启步骤前加在途互斥守卫：执行獭上有其他任务的存活 running 执行时，不重启、记 skipped 退出。"
change_type: fix
capability_tags: [scheduler, restart, reliability]
created: 2026-10-14
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [scheduler, restartBeforeInvoke, inflight-guard]
modules: [src/usecases/scheduler/scheduler-service.ts]
causal_links:
  - F20260815rstrt  # restartBeforeInvoke 初版（本特性在其语义内补守卫）
issue: 1471
---

# 定时任务触发前重启的在途互斥守卫（#1471）

## 背景与案发现场

2026-10-14 每日健康检查发现定时任务执行完整性受损（issue #1471）。排查实查 scheduled_task_executions 台账：

- **今早现场**：8:00「每日补丁清单回看」running 17 分钟后被「进程重启对账」翻篇 failed；8:30 健康检查接力 running。机制：健康检查的 `restartBeforeInvoke` 重启共享执行獭（session 换世、在途上下文全焚），把补丁清单的执行现场掐断。
- **10-12 全日停摆**：self-healing-analysis、每日 issue 处理、上下文观察三条同獭 cron 任务全部跑满 24h 硬上限才 failed——第一个任务假死后，同獭后续任务连环挤占，全天错过窗口。

根因链：**多个定时任务共享同一执行獭时链条严格串行**（triggerTask 全程 await 链 settle），而 `restartBeforeInvoke` 重启无任何在途互斥检查——后触发任务的重启会焚毁先触发任务的执行上下文，且重启后自身 prompt 落库也因 session 换世流离失所（零产出）。

## 设计取舍

**机制识别检查点判定（动手前完成）**：逐项未命中——不新增配置项/持久状态/存储结构/新信号类型/新生命周期/新通道，是在 restartBeforeInvoke 既有语义内补一个守卫条件。修法决策树 ① narrow-fix，**豁免机制预算四问**。

**修法选择**：只挡 restart 步骤，不挡 speak 路径——restart 焚上下文是危害本体；speak 路径不焚上下文，由 claim 锁天然串行（同任务在途时跳过），无需额外守卫。

**宽严口径**：宽口径——「prompt 已落库但发言石未消化」的待点火执行（台账上记 running）也视为在途。宁跳过一轮（挤占 healing 可见 + 下个 cron 窗口补跑），不冒焚毁在途上下文的风险。

**滞留阈值复用**：存活判定沿用 #1449 的 `RUNNING_STUCK_THRESHOLD_MS`（2h）——超阈值的 running 执行已由轮询扫描判死/claim 放行路径管辖，不构成受害者，重启它无害。

**失败兜底**：在途查询抛错时保守放行（维持现状语义：重启照常）——查询失败属异常路径，阻断任务执行比漏挡一次重启代价更高；claim 路径的台账判活是双保险。

**实现选择**：逐任务查 `getExecutions(taskId, {limit: 5})` 复用现有仓储接口，不扩接口面。任务数 ~10 量级、触发时一次，代价可忽略。

**配套可见性**：守卫跳过复用 #1449 的 `recordPreemptionSkipHealing`（与 claim 挤占同族，共用 1h 节流窗）——跳过即见，不靠翻 DB。

## 变更内容

- `scheduler-service.ts` `triggerTask`：restartBeforeInvoke 分支在 `manageSession.restartSession` 前加 `hasInflightExecutionOnOtter` 守卫——命中则 `handleExecutionSkipped`（记 skipped，不污染 consecutiveFailures）+ 挤占 healing + 返回，不重启不 invoke
- 新增私有方法 `hasInflightExecutionOnOtter(task, otterId)`：遍历 active 任务（排除自身、过滤目标獭），查最近执行记录，存在存活 running（未超 2h 阈值）即返回 true；查询失败保守放行
- 测试：mock `getExecutions` 接 `_executions` store；新增 5 个用例（拦截/无在途放行/他獭放行/僵尸放行/查询失败放行）

## 验证

- `npx tsc --noEmit` 干净
- `npx eslint`（改动两文件）干净
- `tests/usecases/scheduler/` + `tests/frameworks/db/scheduled-task/`：184 passed（93 既有全绿 + 5 新增）
- 失败用例证据（bugfix Verification 硬规则）：案发现场为生产台账（8:00 补丁清单执行 de0eeaa3 running 17min 后被翻篇 failed，errorMessage=「进程重启对账：执行被中断」）；新增用例「执行獭有存活 running 执行时：不重启」即为该现场的最小复现——修复前该用例不存在守卫会失败（restart 被调用），修复后通过
- 最简实现检查：已过——守卫复用 `getAllActiveTasks` + `getExecutions` 现有接口与 `RUNNING_STUCK_THRESHOLD_MS` 现有阈值，零新依赖、零新配置

## 影响范围

- 行为变化面：`restartBeforeInvoke=true` 的任务（当前全部 9 条 active cron 任务均为 true），当执行獭有其他任务在途时，本轮触发跳过而非掐断对方。跳过可见性：execution 记 skipped + 挤占 healing（low，1h 节流）
- 不触及：speak 路径（scheduler-triggered-message）、claim 锁、reap 扫描、看门狗
- 遗留（不在本特性范围）：#1471 根因链二「进程重启翻篇后的 claim 挤占窗口」已由 #1449 机制覆盖，观察一轮再定是否增强；执行链假死本身（10-12 三条任务跑满 24h）的根治属链引擎/发言石域，另案

## 对抗审视 round1 与处置（2026-10-14，检视獭-1474 / kimi-k28）

审视结论：0 严重 / 3 建议；连环互锁、记账语义、保守放行取舍、#1449 边界四项焦点核实全部通过。

- **发现 1（采纳，本 PR 修复）**：守卫跳过复用 `recordPreemptionSkipHealing` 的「挤占」文案与互斥保护语义不符 → 加 `reason: '挤占' | '互斥保护'` 可选参数，守卫路径传 '互斥保护'，排查时一眼区分
- **发现 2（建 issue #1475）**：once+restartBeforeInvoke 组合下守卫跳过后 once 任务被静默删除（理论边界，当前 DB 无此组合）——改 once 重试语义超出 narrow-fix 范围，另案跟踪
- **发现 3（采纳，本 PR 修复）**：测试 mock `getExecutions` 忽略 limit 与真实仓储语义漂移 → mock 补 triggeredAt DESC 排序 + limit 裁剪对齐
